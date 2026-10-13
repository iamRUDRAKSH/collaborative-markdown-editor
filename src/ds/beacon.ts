/**
 * The beacon protocol.
 *
 * Unit III: beacon protocol, and the failure detector the election algorithms depend on.
 * Unit II (self study): Fault tolerance.
 *
 * One periodic message does four jobs at once, which is why it is worth building first:
 *
 *   1. Liveness      -- a peer that stops beaconing is suspected down.
 *   2. Clock state   -- every beacon carries the sender's Lamport and vector clocks,
 *                       so the inspector can show the group's logical time advancing.
 *   3. Clock sync    -- the beacon/ack pair is a timed round trip, which is exactly the
 *                       four timestamps Cristian's algorithm needs.
 *   4. Lock gossip   -- each beacon carries what the sender believes about the lock
 *                       table, which is how a late joiner learns the current state.
 *
 * Failure detection here is *unreliable* in the formal sense: a slow network is
 * indistinguishable from a crashed peer, so the detector can suspect a live node. The
 * election algorithm is written to tolerate that -- a wrongly suspected coordinator
 * simply loses an election it would otherwise have won.
 */

import type { ServiceContext } from "./context";
import { cristian } from "./clocksync";
import type { TimeSample } from "./clocksync";
import type { LockEntry, NodeId, PeerState, VectorClockState } from "./types";

export const BEACON = "beacon";
export const BEACON_ACK = "beacon-ack";

/** How often each node beacons. */
export const BEACON_INTERVAL_MS = 2000;

/** Missed beacons before a peer is suspected. Three intervals tolerates one lost frame. */
export const BEACON_MISS_LIMIT = 3;

type BeaconBody = {
  lamport: number;
  vc: VectorClockState;
  locks: LockEntry[];
  coordinator: NodeId | null;
  /** Sender's local clock when the beacon left, for the time sample. */
  t1: number;
};

type BeaconAckBody = {
  /** Echoed back so the originator can match the sample. */
  t1: number;
  /** Responder's clock when the beacon arrived. */
  t2: number;
  /** Responder's clock when the ack left. */
  t3: number;
  lamport: number;
  vc: VectorClockState;
};

export type BeaconHooks = {
  /** What this node currently believes the lock table is. */
  locks: () => LockEntry[];
  /** What this node currently believes the coordinator is. */
  coordinator: () => NodeId | null;
  /** Called when a peer misses too many beacons. */
  onSuspect: (peer: NodeId) => void;
  /** Called when a beacon carries lock state from a peer. */
  onRemoteLocks: (peer: NodeId, locks: LockEntry[], coordinator: NodeId | null) => void;
};

export class BeaconService {
  private readonly ctx: ServiceContext;
  private readonly hooks: BeaconHooks;

  private readonly peerState = new Map<NodeId, PeerState>();
  private readonly suspected = new Set<NodeId>();

  private timer: number | null = null;
  private beaconsSent = 0;
  private beaconsReceived = 0;

  constructor(ctx: ServiceContext, hooks: BeaconHooks) {
    this.ctx = ctx;
    this.hooks = hooks;
  }

  start(): void {
    if (this.timer !== null) {
      return;
    }
    this.timer = window.setInterval(() => this.sweep(), BEACON_INTERVAL_MS);
    this.sweep();
  }

  stop(): void {
    if (this.timer !== null) {
      window.clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** Register a peer the moment its channel opens, so it is tracked before its first beacon. */
  trackPeer(peer: NodeId, name: string): void {
    if (!this.peerState.has(peer)) {
      this.peerState.set(peer, {
        id: peer,
        name,
        connected: true,
        lastBeaconAt: this.ctx.clock.localNow(),
        clockOffsetMs: null,
        rttMs: null,
        lamport: 0,
        vc: {},
      });
    } else {
      const state = this.peerState.get(peer);
      if (state) {
        state.connected = true;
        state.name = name;
        state.lastBeaconAt = this.ctx.clock.localNow();
      }
    }
    this.suspected.delete(peer);
    this.ctx.changed();
  }

  forgetPeer(peer: NodeId): void {
    this.peerState.delete(peer);
    this.suspected.delete(peer);
    this.ctx.changed();
  }

  /** One beacon round: broadcast ours, then check who has gone quiet. */
  private sweep(): void {
    const body: BeaconBody = {
      lamport: this.ctx.lamport.value,
      vc: this.ctx.vc.snapshot(),
      locks: this.hooks.locks(),
      coordinator: this.hooks.coordinator(),
      t1: this.ctx.clock.localNow(),
    };

    const sent = this.ctx.broadcast(BEACON, body);
    this.beaconsSent += sent;

    this.detectFailures();
  }

  private detectFailures(): void {
    const now = this.ctx.clock.localNow();
    const deadline = BEACON_INTERVAL_MS * BEACON_MISS_LIMIT;

    for (const state of this.peerState.values()) {
      const silentFor = now - state.lastBeaconAt;

      if (silentFor > deadline && !this.suspected.has(state.id)) {
        this.suspected.add(state.id);
        this.ctx.log(
          `no beacon from ${state.name} for ${Math.round(silentFor)}ms -- suspected down`,
          "beacon",
          "warn",
        );
        this.hooks.onSuspect(state.id);
        this.ctx.changed();
      }
    }
  }

  /** Handle beacon traffic. Returns true if the envelope belonged to this service. */
  accept(kind: string, from: NodeId, body: unknown): boolean {
    if (kind === BEACON) {
      this.onBeacon(from, body as BeaconBody);
      return true;
    }

    if (kind === BEACON_ACK) {
      this.onAck(from, body as BeaconAckBody);
      return true;
    }

    return false;
  }

  private onBeacon(from: NodeId, body: BeaconBody): void {
    const t2 = this.ctx.clock.localNow();
    this.beaconsReceived += 1;

    const state = this.peerState.get(from);
    if (state) {
      state.lastBeaconAt = t2;
      state.lamport = body.lamport;
      state.vc = body.vc;
      state.connected = true;
    }

    if (this.suspected.delete(from)) {
      this.ctx.log(`${this.ctx.peerName(from)} is beaconing again`, "beacon", "success");
    }

    this.hooks.onRemoteLocks(from, body.locks ?? [], body.coordinator ?? null);

    // Reply immediately so the round trip measures the network, not our scheduling.
    const ack: BeaconAckBody = {
      t1: body.t1,
      t2,
      t3: this.ctx.clock.localNow(),
      lamport: this.ctx.lamport.value,
      vc: this.ctx.vc.snapshot(),
    };
    this.ctx.send(from, BEACON_ACK, ack);
    this.ctx.changed();
  }

  private onAck(from: NodeId, body: BeaconAckBody): void {
    const sample: TimeSample = {
      t1: body.t1,
      t2: body.t2,
      t3: body.t3,
      t4: this.ctx.clock.localNow(),
    };

    const { rttMs, offsetMs } = cristian(sample);

    const state = this.peerState.get(from);
    if (state) {
      state.rttMs = Math.round(rttMs);
      state.clockOffsetMs = Math.round(offsetMs);
      state.lamport = body.lamport;
      state.vc = body.vc;
      state.lastBeaconAt = sample.t4;
    }

    this.ctx.changed();
  }

  /** Offsets of every peer we have a measurement for, for the Berkeley round. */
  offsets(): { node: NodeId; offsetMs: number }[] {
    return [...this.peerState.values()]
      .filter((state) => state.clockOffsetMs !== null)
      .map((state) => ({ node: state.id, offsetMs: state.clockOffsetMs as number }));
  }

  peerStates(): PeerState[] {
    return [...this.peerState.values()].sort((a, b) => a.id - b.id);
  }

  isSuspected(peer: NodeId): boolean {
    return this.suspected.has(peer);
  }

  /** Peers that are connected and not currently suspected. */
  liveNodes(): NodeId[] {
    return [...this.peerState.values()]
      .filter((state) => state.connected && !this.suspected.has(state.id))
      .map((state) => state.id);
  }

  stats(): { sent: number; received: number } {
    return { sent: this.beaconsSent, received: this.beaconsReceived };
  }
}
