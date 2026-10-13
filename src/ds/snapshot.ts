/**
 * Chandy-Lamport distributed snapshot.
 *
 * Unit III: Global State.
 * Unit IV (self study): Blockchain and distributed ledger technologies.
 *
 * FA-1 displayed a SHA-256 of the local document and called it a convergence check. That
 * was honest as far as it went, but it is *not* a global state: each node hashed its own
 * replica at its own local moment, nothing recorded what was in flight, and two nodes
 * mid-exchange would disagree without either being wrong.
 *
 * This is the real thing. The marker rule:
 *
 *   - The initiator records its local state, then sends a marker on every outgoing
 *     channel before sending anything else.
 *   - On receiving its FIRST marker, a node records its local state, declares the channel
 *     the marker arrived on empty, sends markers on all its other outgoing channels, and
 *     starts recording every other incoming channel.
 *   - On receiving a LATER marker on channel c, the node stops recording c; what it
 *     recorded is c's channel state.
 *
 * The result is a consistent cut: a global state the system could genuinely have passed
 * through, even though no node ever observed it directly and no clock was consulted.
 *
 * Each completed snapshot is hashed and chained to the previous one, so the sequence is
 * tamper-evident -- a minimal distributed ledger over the document's global history. The
 * trade-off discussion belongs in the report: this gives integrity of the record without
 * paying for consensus, which is the opposite of the choice a blockchain makes.
 */

import type { ServiceContext } from "./context";
import type {
  Envelope,
  LockEntry,
  NodeId,
  Snapshot,
  SnapshotLocalState,
} from "./types";

export const SNAPSHOT_MARKER = "snapshot-marker";
export const SNAPSHOT_STATE = "snapshot-state";

type MarkerBody = { snapshotId: string; initiator: NodeId };
type StateBody = {
  snapshotId: string;
  local: SnapshotLocalState;
  channels: Record<string, Envelope[]>;
};

export type SnapshotHooks = {
  /** Length of the Yjs document text, the application state we record. */
  docLength: () => number;
  locks: () => LockEntry[];
  coordinator: () => NodeId | null;
  liveNodes: () => NodeId[];
};

/** One snapshot run in progress on this node. */
type Run = {
  id: string;
  initiator: NodeId;
  /** Our own recorded local state. */
  local: SnapshotLocalState;
  /** Channels we are still recording, keyed by the peer we receive from. */
  recording: Map<NodeId, Envelope[]>;
  /** Channels whose marker has arrived; what we captured on each is its channel state. */
  channels: Map<NodeId, Envelope[]>;
  /** Peers whose marker has arrived. */
  markersFrom: Set<NodeId>;
  /** Peers we expect a marker from. */
  expecting: Set<NodeId>;
  /** Initiator only: states collected from participants. */
  collected: Map<NodeId, StateBody>;
  startedAt: number;
};

export class SnapshotService {
  private readonly ctx: ServiceContext;
  private readonly hooks: SnapshotHooks;

  private readonly runs = new Map<string, Run>();
  private readonly completed: Snapshot[] = [];

  private sequence = 0;

  constructor(ctx: ServiceContext, hooks: SnapshotHooks) {
    this.ctx = ctx;
    this.hooks = hooks;
  }

  history(): Snapshot[] {
    return [...this.completed].reverse();
  }

  get latest(): Snapshot | null {
    return this.completed.length > 0 ? this.completed[this.completed.length - 1] : null;
  }

  get inProgress(): boolean {
    return this.runs.size > 0;
  }

  /** Begin a snapshot. Any node may initiate; several may run concurrently. */
  initiate(): string {
    this.sequence += 1;
    const id = `snap-${this.ctx.selfId}-${this.sequence}`;
    const peers = this.hooks.liveNodes();

    const run = this.beginRun(id, this.ctx.selfId, peers);

    this.ctx.log(`snapshot ${id}: recorded local state, sending markers`, "snapshot");

    // The marker must leave before any further application message on that channel.
    const sent = this.ctx.broadcast(SNAPSHOT_MARKER, {
      snapshotId: id,
      initiator: this.ctx.selfId,
    } satisfies MarkerBody);

    if (sent === 0) {
      // Single-node system: the snapshot is just our own local state.
      void this.finishRun(run);
    }

    this.ctx.changed();
    return id;
  }

  private beginRun(id: string, initiator: NodeId, peers: NodeId[]): Run {
    const local: SnapshotLocalState = {
      nodeId: this.ctx.selfId,
      lamport: this.ctx.lamport.value,
      vc: this.ctx.vc.snapshot(),
      docLength: this.hooks.docLength(),
      locks: this.hooks.locks(),
      coordinator: this.hooks.coordinator(),
    };

    const run: Run = {
      id,
      initiator,
      local,
      recording: new Map(),
      channels: new Map(),
      markersFrom: new Set(),
      expecting: new Set(peers),
      collected: new Map(),
      startedAt: performance.now(),
    };

    // Start recording every incoming channel.
    for (const peer of peers) {
      run.recording.set(peer, []);
    }

    this.runs.set(id, run);
    return run;
  }

  /**
   * Record an application message if it arrived on a channel still being recorded.
   * Called by the node for every non-marker envelope received.
   */
  observe(envelope: Envelope): void {
    for (const run of this.runs.values()) {
      const channel = run.recording.get(envelope.from);
      if (channel) {
        channel.push(envelope);
      }
    }
  }

  accept(kind: string, from: NodeId, body: unknown): boolean {
    if (kind === SNAPSHOT_MARKER) {
      this.onMarker(from, body as MarkerBody);
      return true;
    }

    if (kind === SNAPSHOT_STATE) {
      this.onState(from, body as StateBody);
      return true;
    }

    return false;
  }

  private onMarker(from: NodeId, body: MarkerBody): void {
    let run = this.runs.get(body.snapshotId);

    if (!run) {
      // First marker for this snapshot: record our local state now, before anything else.
      const peers = this.hooks.liveNodes();
      run = this.beginRun(body.snapshotId, body.initiator, peers);

      this.ctx.log(
        `snapshot ${body.snapshotId}: first marker from ${this.ctx.peerName(from)}, state recorded`,
        "snapshot",
      );

      // Propagate a marker on EVERY outgoing channel, including back to the sender.
      // Channels are directed: the channel from us to `from` is a different channel from
      // the one the marker arrived on, and the initiator is waiting for a marker on it.
      // Omitting it leaves the initiator waiting forever and the snapshot incomplete.
      for (const peer of peers) {
        this.ctx.send(peer, SNAPSHOT_MARKER, body);
      }
    }

    // The channel this marker arrived on stops recording; whatever we captured on it is
    // its channel state. A channel closed by the first marker is empty by definition.
    run.markersFrom.add(from);
    run.channels.set(from, run.recording.get(from) ?? []);
    run.recording.delete(from);

    if (run.markersFrom.size >= run.expecting.size) {
      void this.finishRun(run);
    }

    this.ctx.changed();
  }

  private async finishRun(run: Run): Promise<void> {
    this.runs.delete(run.id);

    const channels: Record<string, Envelope[]> = {};

    // Channels closed by a marker carry what we recorded on them.
    for (const [peer, messages] of run.channels.entries()) {
      channels[`${peer}->${this.ctx.selfId}`] = messages;
    }

    // Any channel still open (a peer that went away mid-snapshot) contributes what it has.
    for (const [peer, messages] of run.recording.entries()) {
      channels[`${peer}->${this.ctx.selfId}`] = messages;
    }

    const payload: StateBody = {
      snapshotId: run.id,
      local: run.local,
      channels,
    };

    if (run.initiator === this.ctx.selfId) {
      run.collected.set(this.ctx.selfId, payload);
      await this.tryAssemble(run);
      return;
    }

    this.ctx.send(run.initiator, SNAPSHOT_STATE, payload);
    this.ctx.log(`snapshot ${run.id}: sent local state to initiator`, "snapshot");
  }

  private async onState(from: NodeId, body: StateBody): Promise<void> {
    // The initiator may have already finished its own run, so keep a holding area.
    let run = this.runs.get(body.snapshotId);

    if (!run) {
      run = this.pendingAssembly.get(body.snapshotId);
    }

    if (!run) {
      // Our own run completed and was assembled; a late state still gets folded in.
      const existing = this.completed.find((snap) => snap.id === body.snapshotId);
      if (existing) {
        existing.localStates[from] = body.local;
        Object.assign(existing.channelStates, body.channels);
        this.ctx.changed();
      }
      return;
    }

    run.collected.set(from, body);
    await this.tryAssemble(run);
  }

  /** Runs whose markers are done but whose participant states are still arriving. */
  private readonly pendingAssembly = new Map<string, Run>();

  private async tryAssemble(run: Run): Promise<void> {
    this.pendingAssembly.set(run.id, run);

    const expected = run.expecting.size + 1;

    if (run.collected.size < expected) {
      // Give participants a moment; assemble with whatever arrived if some never do.
      window.setTimeout(() => {
        if (this.pendingAssembly.has(run.id)) {
          void this.assemble(run, false);
        }
      }, 2500);
      return;
    }

    await this.assemble(run, true);
  }

  private async assemble(run: Run, complete: boolean): Promise<void> {
    this.pendingAssembly.delete(run.id);

    const localStates: Record<NodeId, SnapshotLocalState> = {};
    const channelStates: Record<string, Envelope[]> = {};

    for (const [node, payload] of run.collected.entries()) {
      localStates[node] = payload.local;
      Object.assign(channelStates, payload.channels);
    }

    const prevHash = this.latest?.hash ?? null;
    const hash = await hashSnapshot(run.id, localStates, channelStates, prevHash);

    const snapshot: Snapshot = {
      id: run.id,
      initiator: run.initiator,
      startedAt: run.startedAt,
      localStates,
      channelStates,
      hash,
      prevHash,
      complete,
    };

    this.completed.push(snapshot);

    const inFlight = Object.values(channelStates).reduce(
      (sum, messages) => sum + messages.length,
      0,
    );

    this.ctx.log(
      `snapshot ${run.id} assembled: ${Object.keys(localStates).length} node(s), ` +
        `${inFlight} message(s) in flight, hash ${hash.slice(0, 12)}`,
      "snapshot",
      complete ? "success" : "warn",
    );

    this.ctx.changed();
  }

  destroy(): void {
    this.runs.clear();
    this.pendingAssembly.clear();
  }
}

/**
 * Hash a snapshot, chaining it to its predecessor.
 *
 * Keys are sorted so two nodes hashing the same logical snapshot agree byte for byte --
 * JSON key order is otherwise insertion order and would make identical states hash
 * differently.
 */
async function hashSnapshot(
  id: string,
  localStates: Record<NodeId, SnapshotLocalState>,
  channelStates: Record<string, Envelope[]>,
  prevHash: string | null,
): Promise<string> {
  const canonical = JSON.stringify({
    id,
    prevHash,
    local: Object.keys(localStates)
      .map(Number)
      .sort((a, b) => a - b)
      .map((node) => ({
        node,
        lamport: localStates[node].lamport,
        docLength: localStates[node].docLength,
        locks: [...localStates[node].locks].sort((a, b) =>
          a.section.localeCompare(b.section),
        ),
      })),
    channels: Object.keys(channelStates)
      .sort()
      .map((key) => ({ key, count: channelStates[key].length })),
  });

  const bytes = new TextEncoder().encode(canonical);
  const digest = await crypto.subtle.digest("SHA-256", bytes);

  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}
