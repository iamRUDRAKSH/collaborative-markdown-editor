/**
 * The shared context every coordination service receives.
 *
 * Services (beacon, election, mutex, snapshot, deadlock, store) never talk to the mesh
 * or to each other directly. They go through this interface, which keeps each algorithm
 * readable on its own and lets the node wire them together in one place.
 */

import type { LamportClock, VectorClock } from "./clocks";
import type { RpcEndpoint } from "./rpc";
import type { AdjustableClock } from "./clocksync";
import type { NodeId } from "./types";

export type ServiceContext = {
  selfId: NodeId;
  selfName: string;

  lamport: LamportClock;
  vc: VectorClock;
  clock: AdjustableClock;
  rpc: RpcEndpoint;

  /** Send one message to one peer. Stamps clocks automatically. */
  send: (peer: NodeId, kind: string, body: unknown) => boolean;
  /** Send one message to every connected peer. Returns how many were sent. */
  broadcast: (kind: string, body: unknown) => number;

  /** Ids of peers with an open data channel, excluding ourselves. */
  peers: () => NodeId[];
  /** Display name for a peer. */
  peerName: (peer: NodeId) => string;

  log: (text: string, source: string, level?: "info" | "warn" | "success") => void;
  /** Tell the UI that observable state changed. */
  changed: () => void;

  /** Count a control message against the current mutual-exclusion measurement. */
  countMessage: (n: number) => void;
};
