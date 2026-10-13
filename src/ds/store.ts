/**
 * A peer-replicated, content-addressed chunk store for document attachments.
 *
 * Unit IV: Distributed file system (and the Apache Hadoop / HDFS case study).
 *
 * The design borrows HDFS's shape and shrinks it to fit a browser mesh:
 *
 *   HDFS                          here
 *   ----                          ----
 *   128 MB blocks                 64 KB chunks
 *   NameNode holds the block map  the elected coordinator holds the chunk map
 *   DataNodes hold replicas       peers hold replicas, k = 2 by default
 *   heartbeats detect DataNodes   the beacon protocol detects peers
 *   re-replication on node loss   re-replication on peer loss
 *
 * Content addressing is the one place we deviate usefully: a chunk's id is the SHA-256 of
 * its bytes, so a chunk is self-verifying and duplicate content is stored once. That makes
 * the integrity check free, which matters when replicas live on machines you do not trust.
 *
 * The honest limitation to state in the viva: with every replica in a browser tab, the
 * durability story is only as good as the tabs. Closing the last two holding a chunk loses
 * it. HDFS solves this with disks and a replication factor tuned to real failure rates;
 * we can only re-replicate while enough peers remain.
 */

import type { ServiceContext } from "./context";
import type { ChunkMeta, NodeId, StoredFile } from "./types";

/** Chunk size. Small enough that a data channel frame carries one comfortably. */
export const CHUNK_SIZE = 64 * 1024;

/** Replication factor. Two is the minimum that survives a single peer loss. */
export const REPLICATION_FACTOR = 2;

export type StoreHooks = {
  liveNodes: () => NodeId[];
  isCoordinator: () => boolean;
  coordinator: () => NodeId | null;
};

export class ChunkStore {
  private readonly ctx: ServiceContext;
  private readonly hooks: StoreHooks;

  /** Chunk bytes we personally hold, keyed by content hash. Base64 for JSON transport. */
  private readonly blocks = new Map<string, string>();

  /** The file catalogue. Authoritative on the coordinator, cached elsewhere. */
  private readonly files = new Map<string, StoredFile>();

  constructor(ctx: ServiceContext, hooks: StoreHooks) {
    this.ctx = ctx;
    this.hooks = hooks;
  }

  /** Register the RPC surface this node exposes as a storage peer. */
  registerHandlers(): void {
    // A DataNode-equivalent operation: accept and hold a replica.
    this.ctx.rpc.register("store.put", (params) => {
      const [hash, data] = params as [string, string];
      this.blocks.set(hash, data);
      return { stored: true, hash };
    });

    // Read a replica back.
    this.ctx.rpc.register("store.get", (params) => {
      const [hash] = params as [string];
      const data = this.blocks.get(hash);
      if (data === undefined) {
        throw new Error(`chunk ${hash.slice(0, 8)} not held here`);
      }
      return data;
    });

    // Does this peer hold the chunk? Used when re-replicating.
    this.ctx.rpc.register("store.has", (params) => {
      const [hash] = params as [string];
      return this.blocks.has(hash);
    });

    // NameNode-equivalent: the catalogue, served by whoever is coordinator.
    this.ctx.rpc.register("store.catalogue", () => [...this.files.values()]);

    this.ctx.rpc.register("store.announce", (params) => {
      const [file] = params as [StoredFile];
      this.files.set(file.id, file);
      this.ctx.changed();
      return true;
    });
  }

  catalogue(): StoredFile[] {
    return [...this.files.values()].sort((a, b) => b.uploadedAt - a.uploadedAt);
  }

  localChunkCount(): number {
    return this.blocks.size;
  }

  localBytes(): number {
    let total = 0;
    for (const data of this.blocks.values()) {
      total += Math.floor((data.length * 3) / 4);
    }
    return total;
  }

  /** Split a file, replicate every chunk, then publish the catalogue entry. */
  async upload(file: File): Promise<StoredFile> {
    const buffer = new Uint8Array(await file.arrayBuffer());
    const chunks: ChunkMeta[] = [];

    this.ctx.log(
      `storing ${file.name}: ${Math.ceil(buffer.length / CHUNK_SIZE)} chunk(s), replication ${REPLICATION_FACTOR}`,
      "store",
    );

    for (let offset = 0, index = 0; offset < buffer.length; offset += CHUNK_SIZE, index += 1) {
      const slice = buffer.subarray(offset, Math.min(offset + CHUNK_SIZE, buffer.length));
      const hash = await sha256(slice);
      const encoded = toBase64(slice);

      // Always keep a local replica, then place the remaining copies on peers.
      this.blocks.set(hash, encoded);
      const replicas: NodeId[] = [this.ctx.selfId];

      for (const peer of this.placementFor(hash)) {
        if (replicas.length >= REPLICATION_FACTOR) {
          break;
        }
        try {
          await this.ctx.rpc.call(peer, "store.put", [hash, encoded], 8000);
          replicas.push(peer);
        } catch {
          this.ctx.log(`replica placement on node ${peer} failed`, "store", "warn");
        }
      }

      if (replicas.length < REPLICATION_FACTOR) {
        this.ctx.log(
          `chunk ${hash.slice(0, 8)} under-replicated (${replicas.length}/${REPLICATION_FACTOR})`,
          "store",
          "warn",
        );
      }

      chunks.push({ hash, index, size: slice.length, replicas });
    }

    const stored: StoredFile = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      name: file.name,
      size: buffer.length,
      mime: file.type || "application/octet-stream",
      chunks,
      uploadedBy: this.ctx.selfId,
      uploadedAt: this.ctx.clock.now(),
    };

    this.files.set(stored.id, stored);

    // Publish to the catalogue so every peer can see the file exists.
    for (const peer of this.hooks.liveNodes()) {
      void this.ctx.rpc.call(peer, "store.announce", [stored], 5000).catch(() => undefined);
    }

    this.ctx.log(`stored ${file.name} (${chunks.length} chunk(s))`, "store", "success");
    this.ctx.changed();
    return stored;
  }

  /** Reassemble a file by fetching each chunk from whichever replica answers. */
  async download(fileId: string): Promise<Blob> {
    const file = this.files.get(fileId);
    if (!file) {
      throw new Error("file not in catalogue");
    }

    const parts: Uint8Array[] = [];

    for (const chunk of [...file.chunks].sort((a, b) => a.index - b.index)) {
      const local = this.blocks.get(chunk.hash);

      if (local !== undefined) {
        parts.push(fromBase64(local));
        continue;
      }

      let fetched: string | null = null;

      for (const replica of chunk.replicas) {
        if (replica === this.ctx.selfId) {
          continue;
        }
        try {
          fetched = await this.ctx.rpc.call<string>(replica, "store.get", [chunk.hash], 8000);
          break;
        } catch {
          // Try the next replica. This is the point of having more than one.
        }
      }

      if (fetched === null) {
        throw new Error(`chunk ${chunk.hash.slice(0, 8)} unavailable on every replica`);
      }

      const bytes = fromBase64(fetched);

      // Content addressing makes verification free: the id *is* the expected hash.
      const actual = await sha256(bytes);
      if (actual !== chunk.hash) {
        throw new Error(`chunk ${chunk.hash.slice(0, 8)} failed integrity check`);
      }

      parts.push(bytes);
    }

    return new Blob(parts as BlobPart[], { type: file.mime });
  }

  /**
   * Re-replicate chunks that lost a replica with a failed peer.
   *
   * This is the HDFS behaviour of restoring the replication factor after a DataNode is
   * declared dead, driven here by the beacon failure detector.
   */
  async onPeerDown(peer: NodeId): Promise<void> {
    const live = this.hooks.liveNodes();
    let repaired = 0;

    for (const file of this.files.values()) {
      for (const chunk of file.chunks) {
        if (!chunk.replicas.includes(peer)) {
          continue;
        }

        chunk.replicas = chunk.replicas.filter((node) => node !== peer);

        if (chunk.replicas.length >= REPLICATION_FACTOR) {
          continue;
        }

        const data = this.blocks.get(chunk.hash);
        if (data === undefined) {
          // We do not hold it ourselves, so we cannot be the one to repair it.
          continue;
        }

        const target = live.find((node) => !chunk.replicas.includes(node));
        if (target === undefined) {
          continue;
        }

        try {
          await this.ctx.rpc.call(target, "store.put", [chunk.hash, data], 8000);
          chunk.replicas.push(target);
          repaired += 1;
        } catch {
          // The target may be going away too; the next sweep will try again.
        }
      }
    }

    if (repaired > 0) {
      this.ctx.log(`re-replicated ${repaired} chunk(s) after node ${peer} was lost`, "store", "success");
      this.ctx.changed();
    }
  }

  /** Candidate peers for a replica, ordered deterministically by the chunk hash. */
  private placementFor(hash: string): NodeId[] {
    const seed = Number.parseInt(hash.slice(0, 8), 16);
    const peers = this.hooks.liveNodes();

    // Rendezvous-style placement: deterministic, and spreads chunks across the mesh
    // instead of piling every chunk onto whichever peer happens to be first.
    return [...peers].sort((a, b) => ((seed ^ a) % 997) - ((seed ^ b) % 997));
  }

  destroy(): void {
    this.blocks.clear();
    this.files.clear();
  }
}

async function sha256(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes as unknown as ArrayBuffer);
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
}

function fromBase64(encoded: string): Uint8Array {
  const binary = atob(encoded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}
