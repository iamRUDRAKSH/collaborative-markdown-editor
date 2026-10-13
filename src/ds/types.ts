/**
 * Shared types for the FA-2 distributed coordination layer.
 *
 * This layer runs alongside the Yjs CRDT replica from FA-1. Yjs stays responsible
 * for coordination-free convergence of the document text. Everything here exists to
 * provide the guarantees a CRDT deliberately cannot: ordering, mutual exclusion,
 * a single coordinator, and a consistent global state.
 */

/** Numeric node identity. Numeric so election algorithms have a total order to work with. */
export type NodeId = number;

/** A vector clock: node id -> number of events observed at that node. */
export type VectorClockState = Record<NodeId, number>;

/** How two events relate under the happened-before relation. */
export type CausalOrder = "before" | "after" | "concurrent" | "equal";

/** Envelope every message on the control plane travels in. */
export type Envelope<T = unknown> = {
  /** Message kind, used for dispatch. */
  kind: string;
  /** Sender node id. */
  from: NodeId;
  /** Target node id, or null when broadcast. */
  to: NodeId | null;
  /** Lamport timestamp at send. */
  lamport: number;
  /** Vector clock at send. */
  vc: VectorClockState;
  /** Local wall-clock time at send, in ms. Used only by the clock-synchronisation module. */
  sentAt: number;
  /** Kind-specific payload. */
  body: T;
};

/** Connection state of one peer in the mesh. */
export type PeerState = {
  id: NodeId;
  name: string;
  /** True once our data channel to this peer is open. */
  connected: boolean;
  /** Local time we last heard a beacon from this peer. */
  lastBeaconAt: number;
  /** Estimated offset of the peer's clock relative to ours, in ms. */
  clockOffsetMs: number | null;
  /** Round-trip time to the peer in ms, from the beacon exchange. */
  rttMs: number | null;
  /** Peer's Lamport clock as of its last beacon. */
  lamport: number;
  /** Peer's vector clock as of its last beacon. */
  vc: VectorClockState;
};

/** Which mutual-exclusion algorithm is currently driving the lock UI. */
export type MutexAlgorithm =
  | "centralized"
  | "lamport"
  | "ricart-agrawala"
  | "token-ring"
  | "lodha-kshemkalyani";

/** Which election algorithm to run when the coordinator is suspected down. */
export type ElectionAlgorithm = "bully" | "ring";

/** A section of the document that can be held exclusively. */
export type SectionId = string;

/** One entry in the distributed lock table. */
export type LockEntry = {
  section: SectionId;
  holder: NodeId;
  /** Lamport timestamp of the request that won the section. */
  grantedAt: number;
};

/** A row in the message-complexity ledger, used for the algorithm comparison. */
export type MessageCost = {
  algorithm: string;
  /** Messages sent for one critical-section entry/exit cycle. */
  messages: number;
  /** Peers participating when the cycle ran. */
  peers: number;
  /** Wall-clock ms from request to grant. */
  latencyMs: number;
};

/** A recorded Chandy-Lamport snapshot. */
export type Snapshot = {
  id: string;
  initiator: NodeId;
  /** Local time the snapshot was initiated, for display only. */
  startedAt: number;
  /** Recorded local state of each node that participated. */
  localStates: Record<NodeId, SnapshotLocalState>;
  /** Messages recorded in-flight per channel, keyed "from->to". */
  channelStates: Record<string, Envelope[]>;
  /** SHA-256 over the snapshot contents, chained to the previous snapshot. */
  hash: string;
  /** Hash of the previous snapshot, or null for the first one. */
  prevHash: string | null;
  complete: boolean;
};

/** The part of a node's state a snapshot records. */
export type SnapshotLocalState = {
  nodeId: NodeId;
  lamport: number;
  vc: VectorClockState;
  /** Length of the Yjs document text at the moment the marker was processed. */
  docLength: number;
  /** Locks this node believed were held. */
  locks: LockEntry[];
  coordinator: NodeId | null;
};

/** An edge in the wait-for graph, used for deadlock detection. */
export type WaitForEdge = {
  waiter: NodeId;
  holder: NodeId;
  section: SectionId;
};

/** A chunk of a file in the peer-replicated store. */
export type ChunkMeta = {
  /** Content address: SHA-256 of the chunk bytes. */
  hash: string;
  index: number;
  size: number;
  /** Nodes believed to be holding a replica. */
  replicas: NodeId[];
};

/** A file in the peer-replicated store. */
export type StoredFile = {
  id: string;
  name: string;
  size: number;
  mime: string;
  chunks: ChunkMeta[];
  uploadedBy: NodeId;
  uploadedAt: number;
};

/** A line in the event log the inspector renders. */
export type LogEntry = {
  seq: number;
  at: number;
  lamport: number;
  /** Module that emitted the line, e.g. "mutex" or "election". */
  source: string;
  text: string;
  level: "info" | "warn" | "success";
};
