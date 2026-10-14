/**
 * DsNode: the coordination node that owns every service and wires them together.
 *
 * One of these runs per browser tab, alongside (and independently of) the Yjs replica.
 * It owns the control-plane mesh, stamps every outgoing message with the logical clocks,
 * and dispatches every incoming message to whichever service claims it.
 *
 * Dispatch order matters in exactly one place: the snapshot service must see an
 * application message *before* the message is acted on, so that a message recorded as
 * in-flight is not also reflected in a recorded local state. Markers themselves are never
 * recorded as channel contents.
 */

import { LamportClock, VectorClock } from "./clocks";
import { AdjustableClock, berkeley } from "./clocksync";
import { BeaconService } from "./beacon";
import { DeadlockService } from "./deadlock";
import { ElectionService } from "./election";
import { Mesh, hasTurnConfigured } from "./transport";
import { MutexService } from "./mutex";
import { RpcEndpoint } from "./rpc";
import { SNAPSHOT_MARKER, SnapshotService } from "./snapshot";
import { ChunkStore } from "./store";
import { collectQos, forgetQos } from "./qos";
import type { PeerQos } from "./qos";
import type { ServiceContext } from "./context";
import type {
  ElectionAlgorithm,
  Envelope,
  LockEntry,
  LogEntry,
  MessageCost,
  MutexAlgorithm,
  NodeId,
  PeerState,
  SectionId,
  Snapshot,
  StoredFile,
  WaitForEdge,
} from "./types";

/** How often the coordinator runs a Berkeley synchronisation round. */
const BERKELEY_INTERVAL_MS = 10000;

const MAX_LOG = 300;

export type DsState = {
  selfId: NodeId;
  selfName: string;
  peers: PeerState[];
  lamport: number;
  vectorClock: Record<number, number>;
  clockCorrectionMs: number;
  coordinator: NodeId | null;
  isCoordinator: boolean;
  electionRunning: boolean;
  electionAlgorithm: ElectionAlgorithm;
  lastElection: { messages: number; latencyMs: number; algorithm: ElectionAlgorithm | null };
  mutexAlgorithm: MutexAlgorithm;
  expectedCost: string;
  locks: LockEntry[];
  costs: MessageCost[];
  snapshots: Snapshot[];
  snapshotRunning: boolean;
  waitForGraph: WaitForEdge[];
  deadlock: { detections: number; probesSent: number; lastCycle: NodeId[] | null };
  files: StoredFile[];
  localChunks: number;
  localBytes: number;
  rpcMethods: string[];
  rpcCalls: number;
  beacons: { sent: number; received: number };
  turnConfigured: boolean;
  qos: PeerQos[];
  mediaOn: boolean;
  remoteStreamIds: NodeId[];
  log: LogEntry[];
};

export type DsNodeOptions = {
  roomId: string;
  userName: string;
  signalingUrl: string;
  /** Length of the Yjs document text, recorded by snapshots as the application state. */
  docLength: () => number;
};

export class DsNode {
  readonly selfId: NodeId;
  readonly selfName: string;

  private readonly mesh: Mesh;
  private readonly rpc: RpcEndpoint;
  private readonly lamport = new LamportClock();
  private readonly vc: VectorClock;
  private readonly clock = new AdjustableClock();

  private readonly beacon: BeaconService;
  private readonly election: ElectionService;
  private readonly mutex: MutexService;
  private readonly snapshot: SnapshotService;
  private readonly deadlock: DeadlockService;
  private readonly store: ChunkStore;

  private readonly listeners = new Set<(state: DsState) => void>();
  private readonly log: LogEntry[] = [];
  private logSeq = 0;

  private berkeleyTimer: number | null = null;
  private qosTimer: number | null = null;
  private notifyScheduled = false;
  private destroyed = false;

  private readonly remoteStreams = new Map<NodeId, MediaStream>();
  private localStream: MediaStream | null = null;
  private qos: PeerQos[] = [];

  constructor(options: DsNodeOptions) {
    // A fresh random id per tab. Numeric because the election algorithms need a total
    // order, and random rather than sequential so no tab is permanently the coordinator.
    this.selfId = Math.floor(Math.random() * 1_000_000) + 1;
    this.selfName = options.userName;
    this.vc = new VectorClock(this.selfId);

    this.rpc = new RpcEndpoint({
      send: (peer, kind, body) => this.sendEnvelope(peer, kind, body),
      onLog: (text, level) => this.appendLog(text, "rpc", level),
    });

    this.mesh = new Mesh({
      selfId: this.selfId,
      selfName: options.userName,
      roomId: options.roomId,
      signalingUrl: options.signalingUrl,
      events: {
        onPeerUp: (id, name) => this.onPeerUp(id, name),
        onPeerDown: (id) => this.onPeerDown(id),
        onMessage: (envelope) => this.onMessage(envelope),
        onLog: (text, level) => this.appendLog(text, "mesh", level),
        onIceEvent: (id, detail) => this.appendLog(`ice ${id}: ${detail}`, "webrtc"),
        onRemoteStream: (id, stream) => {
          if (stream) {
            this.remoteStreams.set(id, stream);
            this.appendLog(`receiving media from ${this.mesh.peerName(id)}`, "media", "success");
          } else {
            this.remoteStreams.delete(id);
            forgetQos(id);
          }
          this.notify();
        },
      },
    });

    const ctx: ServiceContext = {
      selfId: this.selfId,
      selfName: options.userName,
      lamport: this.lamport,
      vc: this.vc,
      clock: this.clock,
      rpc: this.rpc,
      send: (peer, kind, body) => this.sendEnvelope(peer, kind, body),
      broadcast: (kind, body) => this.broadcastEnvelope(kind, body),
      peers: () => this.mesh.connectedPeers(),
      peerName: (peer) => this.mesh.peerName(peer),
      log: (text, source, level) => this.appendLog(text, source, level),
      changed: () => this.notify(),
      countMessage: () => undefined,
    };

    this.beacon = new BeaconService(ctx, {
      locks: () => this.mutex.lockTable().filter((lock) => lock.holder === this.selfId),
      coordinator: () => this.election.coordinator,
      onSuspect: (peer) => {
        this.election.onPeerSuspected(peer);
        this.mutex.onPeerDown(peer);
        void this.store.onPeerDown(peer);
      },
      onRemoteLocks: (peer, locks, coordinator) => {
        this.mutex.mergeRemoteLocks(peer, locks);
        this.election.adoptFromGossip(coordinator);
      },
    });

    this.election = new ElectionService(ctx, {
      onCoordinator: () => this.notify(),
      liveNodes: () => this.beacon.liveNodes(),
    });

    this.mutex = new MutexService(ctx, {
      coordinator: () => this.election.coordinator,
      isCoordinator: () => this.election.isCoordinator,
      liveNodes: () => this.beacon.liveNodes(),
      onLocksChanged: () => this.notify(),
    });

    this.snapshot = new SnapshotService(ctx, {
      docLength: options.docLength,
      locks: () => this.mutex.lockTable(),
      coordinator: () => this.election.coordinator,
      liveNodes: () => this.beacon.liveNodes(),
    });

    this.deadlock = new DeadlockService(ctx, {
      waitingFor: () => this.mutex.waitingFor(),
      abort: (section) => this.mutex.abort(section),
    });

    this.store = new ChunkStore(ctx, {
      liveNodes: () => this.beacon.liveNodes(),
      isCoordinator: () => this.election.isCoordinator,
      coordinator: () => this.election.coordinator,
    });
  }

  start(): void {
    this.store.registerHandlers();

    // Berkeley adjustments arrive as an RPC so the caller learns whether they landed.
    this.rpc.register("clock.adjust", (params) => {
      const [deltaMs] = params as [number];
      this.clock.adjust(deltaMs);
      this.appendLog(
        `berkeley: adjusted clock by ${deltaMs > 0 ? "+" : ""}${Math.round(deltaMs)}ms`,
        "clocksync",
      );
      this.notify();
      return true;
    });

    this.mesh.connect();
    this.beacon.start();
    this.mutex.start();
    this.deadlock.start();

    this.berkeleyTimer = window.setInterval(() => this.runBerkeleyRound(), BERKELEY_INTERVAL_MS);

    // QoS sampling needs two readings to compute a rate, so it runs on its own interval.
    this.qosTimer = window.setInterval(() => {
      void collectQos(this.mesh.peerConnections()).then((samples) => {
        this.qos = samples;
        this.notify();
      });
    }, 2000);

    this.appendLog(`node ${this.selfId} started as "${this.selfName}"`, "node", "success");
    if (!hasTurnConfigured()) {
      this.appendLog("no TURN relay configured -- ICE has no fallback behind symmetric NAT", "webrtc", "warn");
    }
  }

  // --------------------------------------------------------------- messaging

  /** Wrap a body in an envelope, stamping both logical clocks. */
  private envelope(kind: string, to: NodeId | null, body: unknown): Envelope {
    const lamport = this.lamport.tick();
    const vc = this.vc.tick();
    return {
      kind,
      from: this.selfId,
      to,
      lamport,
      vc,
      sentAt: this.clock.localNow(),
      body,
    };
  }

  private sendEnvelope(peer: NodeId, kind: string, body: unknown): boolean {
    return this.mesh.send(peer, this.envelope(kind, peer, body));
  }

  private broadcastEnvelope(kind: string, body: unknown): number {
    return this.mesh.broadcast(this.envelope(kind, null, body));
  }

  private onMessage(envelope: Envelope): void {
    // Lamport rule 2 and the vector-clock merge, applied to every receive.
    this.lamport.update(envelope.lamport);
    this.vc.update(envelope.vc);

    // Record before acting: a message counted as in-flight must not also show up in a
    // local state recorded afterwards.
    if (envelope.kind !== SNAPSHOT_MARKER) {
      this.snapshot.observe(envelope);
    }

    if (this.rpc.accept(envelope)) {
      this.notify();
      return;
    }

    const { kind, from, body } = envelope;

    if (
      this.beacon.accept(kind, from, body) ||
      this.election.accept(kind, from, body) ||
      this.mutex.accept(kind, from, body) ||
      this.snapshot.accept(kind, from, body) ||
      this.deadlock.accept(kind, from, body)
    ) {
      this.notify();
      return;
    }

    this.appendLog(`unhandled message kind "${kind}" from ${from}`, "node", "warn");
  }

  private onPeerUp(id: NodeId, name: string): void {
    this.vc.ensure(id);
    this.beacon.trackPeer(id, name);
    this.election.onPeerJoined();
    this.notify();
  }

  private onPeerDown(id: NodeId): void {
    this.appendLog(`peer ${this.mesh.peerName(id)} disconnected`, "mesh", "warn");
    this.beacon.forgetPeer(id);
    this.election.onPeerSuspected(id);
    this.mutex.onPeerDown(id);
    void this.store.onPeerDown(id);
    this.notify();
  }

  // -------------------------------------------------------------- clock sync

  /**
   * Berkeley round, run only by the coordinator. It averages the offsets it has already
   * measured through the beacon exchange and tells each peer how far to move.
   */
  // [DS-U3-CLOCKSYNC-ROUND] Unit III - Clock Synchronization. Coordinator drives the Berkeley round.
  private runBerkeleyRound(): void {
    if (!this.election.isCoordinator) {
      return;
    }

    const offsets = this.beacon.offsets();
    if (offsets.length === 0) {
      return;
    }

    const { average, adjustments } = berkeley(offsets);

    this.appendLog(
      `berkeley round: group average offset ${average.toFixed(1)}ms across ${offsets.length + 1} node(s)`,
      "clocksync",
    );

    // The coordinator moves to the average too, otherwise it is not synchronising with
    // the group so much as imposing its own clock on it.
    this.clock.adjust(average);

    for (const adjustment of adjustments) {
      void this.rpc
        .call(adjustment.node, "clock.adjust", [adjustment.adjustmentMs], 5000)
        .catch(() => undefined);
    }

    this.notify();
  }

  // ------------------------------------------------------------- public API

  acquire(section: SectionId): Promise<void> {
    return this.mutex.acquire(section);
  }

  release(section: SectionId): void {
    this.mutex.release(section);
  }

  takeSnapshot(): string {
    return this.snapshot.initiate();
  }

  forceElection(): void {
    this.appendLog("election forced from the inspector", "election");
    this.election.start();
  }

  setMutexAlgorithm(algorithm: MutexAlgorithm): void {
    this.mutex.setAlgorithm(algorithm);
  }

  setElectionAlgorithm(algorithm: ElectionAlgorithm): void {
    this.election.setAlgorithm(algorithm);
  }

  uploadFile(file: File): Promise<StoredFile> {
    return this.store.upload(file);
  }

  downloadFile(fileId: string): Promise<Blob> {
    return this.store.download(fileId);
  }

  heldByMe(section: SectionId): boolean {
    return this.mutex.heldByMe(section);
  }

  holderOf(section: SectionId): NodeId | null {
    return this.mutex.holderOf(section);
  }

  peerConnections(): { id: NodeId; pc: RTCPeerConnection }[] {
    return this.mesh.peerConnections();
  }

  /**
   * Start publishing camera and microphone to the mesh.
   *
   * Unit I: Distributed Multimedia Systems. The media rides the same peer connections as
   * the coordination data channel, so no new signaling path is needed -- adding the track
   * triggers renegotiation over the offer/answer exchange we already own.
   */
  // [DS-U1-MULTIMEDIA] Unit I - Distributed Multimedia Systems. Camera and mic over the peer connections.
  async startMedia(): Promise<void> {
    if (this.localStream) {
      return;
    }

    const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: true });
    this.localStream = stream;
    this.mesh.addLocalStream(stream);

    this.appendLog("publishing camera and microphone to peers", "media", "success");
    this.notify();
  }

  stopMedia(): void {
    if (!this.localStream) {
      return;
    }
    this.mesh.removeLocalStream();
    this.localStream = null;
    this.appendLog("stopped publishing media", "media");
    this.notify();
  }

  get localMediaStream(): MediaStream | null {
    return this.localStream;
  }

  remoteStream(id: NodeId): MediaStream | null {
    return this.remoteStreams.get(id) ?? null;
  }

  // ----------------------------------------------------------------- state

  subscribe(listener: (state: DsState) => void): () => void {
    this.listeners.add(listener);
    listener(this.snapshotState());
    return () => {
      this.listeners.delete(listener);
    };
  }

  private appendLog(text: string, source: string, level: LogEntry["level"] = "info"): void {
    this.logSeq += 1;
    this.log.push({
      seq: this.logSeq,
      at: this.clock.localNow(),
      lamport: this.lamport.value,
      source,
      text,
      level,
    });
    if (this.log.length > MAX_LOG) {
      this.log.splice(0, this.log.length - MAX_LOG);
    }
    this.notify();
  }

  /** Coalesce notifications so a burst of messages causes one React render, not twenty. */
  private notify(): void {
    if (this.notifyScheduled || this.destroyed) {
      return;
    }
    this.notifyScheduled = true;
    queueMicrotask(() => {
      this.notifyScheduled = false;
      if (this.destroyed) {
        return;
      }
      const state = this.snapshotState();
      for (const listener of this.listeners) {
        listener(state);
      }
    });
  }

  private snapshotState(): DsState {
    return {
      selfId: this.selfId,
      selfName: this.selfName,
      peers: this.beacon.peerStates(),
      lamport: this.lamport.value,
      vectorClock: this.vc.snapshot(),
      clockCorrectionMs: this.clock.correctionMs,
      coordinator: this.election.coordinator,
      isCoordinator: this.election.isCoordinator,
      electionRunning: this.election.running,
      electionAlgorithm: this.election.currentAlgorithm,
      lastElection: this.election.lastElection(),
      mutexAlgorithm: this.mutex.currentAlgorithm,
      expectedCost: this.mutex.expectedCost(this.beacon.liveNodes().length),
      locks: this.mutex.lockTable(),
      costs: this.mutex.costHistory(),
      snapshots: this.snapshot.history(),
      snapshotRunning: this.snapshot.inProgress,
      waitForGraph: this.deadlock.graph(),
      deadlock: this.deadlock.stats(),
      files: this.store.catalogue(),
      localChunks: this.store.localChunkCount(),
      localBytes: this.store.localBytes(),
      rpcMethods: this.rpc.methods,
      rpcCalls: this.rpc.totalCalls,
      beacons: this.beacon.stats(),
      turnConfigured: hasTurnConfigured(),
      qos: this.qos,
      mediaOn: this.localStream !== null,
      remoteStreamIds: [...this.remoteStreams.keys()],
      log: [...this.log].reverse(),
    };
  }

  destroy(): void {
    this.destroyed = true;
    if (this.berkeleyTimer !== null) {
      window.clearInterval(this.berkeleyTimer);
      this.berkeleyTimer = null;
    }
    if (this.qosTimer !== null) {
      window.clearInterval(this.qosTimer);
      this.qosTimer = null;
    }
    this.stopMedia();
    this.remoteStreams.clear();
    this.beacon.stop();
    this.deadlock.destroy();
    this.mutex.destroy();
    this.snapshot.destroy();
    this.election.destroy();
    this.store.destroy();
    this.rpc.destroy();
    this.mesh.destroy();
    this.listeners.clear();
  }
}
