/**
 * Election algorithms.
 *
 * Unit III: Election Algorithms.
 *
 * Two implementations over the same failure detector, so they can be compared directly:
 *
 *   Bully (Garcia-Molina)  -- O(n^2) messages worst case, but one round trip of latency
 *                             when the highest surviving node starts the election.
 *   Ring (Chang-Roberts)   -- O(n) messages, but latency proportional to ring length.
 *
 * Both elect the node with the highest id, so the outcome is identical and only the cost
 * differs. That is the point of having both: the inspector logs the message count, and
 * the difference between them is visible rather than theoretical.
 *
 * The coordinator earns its keep: it grants locks under centralized mutual exclusion and
 * runs the Berkeley clock-synchronisation round. Without a job to do, electing one would
 * be ceremony.
 */

import type { ServiceContext } from "./context";
import type { ElectionAlgorithm, NodeId } from "./types";

export const ELECTION_BULLY = "election-bully";
export const ELECTION_ANSWER = "election-answer";
export const ELECTION_RING = "election-ring";
export const ELECTION_COORDINATOR = "election-coordinator";

/** How long the bully algorithm waits for a higher node to answer before claiming victory. */
export const ANSWER_TIMEOUT_MS = 1500;

type RingBody = { candidates: NodeId[] };
type CoordinatorBody = { coordinator: NodeId; algorithm: ElectionAlgorithm };

export type ElectionHooks = {
  /** Called whenever the coordinator changes. */
  onCoordinator: (coordinator: NodeId, algorithm: ElectionAlgorithm) => void;
  /** Live peers, from the beacon failure detector. Excludes suspected nodes. */
  liveNodes: () => NodeId[];
};

export class ElectionService {
  private readonly ctx: ServiceContext;
  private readonly hooks: ElectionHooks;

  private algorithm: ElectionAlgorithm = "bully";
  private coordinatorId: NodeId | null = null;
  private inProgress = false;
  private answerTimer: number | null = null;
  private answered = false;

  /** Messages exchanged during the most recent election, for the comparison table. */
  private lastCost = 0;
  private runningCost = 0;
  private startedAt = 0;
  private lastLatencyMs = 0;
  private lastAlgorithm: ElectionAlgorithm | null = null;

  constructor(ctx: ServiceContext, hooks: ElectionHooks) {
    this.ctx = ctx;
    this.hooks = hooks;
  }

  setAlgorithm(algorithm: ElectionAlgorithm): void {
    this.algorithm = algorithm;
    this.ctx.log(`election algorithm set to ${algorithm}`, "election");
    this.ctx.changed();
  }

  get currentAlgorithm(): ElectionAlgorithm {
    return this.algorithm;
  }

  get coordinator(): NodeId | null {
    return this.coordinatorId;
  }

  get isCoordinator(): boolean {
    return this.coordinatorId === this.ctx.selfId;
  }

  get running(): boolean {
    return this.inProgress;
  }

  lastElection(): { messages: number; latencyMs: number; algorithm: ElectionAlgorithm | null } {
    return {
      messages: this.lastCost,
      latencyMs: this.lastLatencyMs,
      algorithm: this.lastAlgorithm,
    };
  }

  /** Adopt a coordinator learned from a beacon, when we have none of our own. */
  adoptFromGossip(coordinator: NodeId | null): void {
    if (coordinator === null || this.inProgress || this.coordinatorId !== null) {
      return;
    }
    this.coordinatorId = coordinator;
    this.hooks.onCoordinator(coordinator, this.algorithm);
    this.ctx.log(`adopted coordinator ${this.ctx.peerName(coordinator)} from beacon`, "election");
    this.ctx.changed();
  }

  /** Called by the failure detector when a peer goes quiet. */
  onPeerSuspected(peer: NodeId): void {
    if (peer === this.coordinatorId) {
      this.ctx.log(`coordinator ${this.ctx.peerName(peer)} is down -- starting election`, "election", "warn");
      this.coordinatorId = null;
      this.start();
    }
  }

  /** Called when a peer joins; a node with no coordinator should find one. */
  onPeerJoined(): void {
    if (this.coordinatorId === null && !this.inProgress) {
      this.start();
    }
  }

  start(): void {
    if (this.inProgress) {
      return;
    }

    this.inProgress = true;
    this.answered = false;
    this.runningCost = 0;
    this.startedAt = performance.now();

    if (this.algorithm === "bully") {
      this.startBully();
    } else {
      this.startRing();
    }

    this.ctx.changed();
  }

  // ------------------------------------------------------------------- bully

  // [DS-U3-ELECTION-BULLY] Unit III - Election Algorithms. Bully, O(n^2) messages.
  private startBully(): void {
    const higher = this.hooks.liveNodes().filter((id) => id > this.ctx.selfId);

    if (higher.length === 0) {
      // Nobody outranks us, so we win immediately without waiting.
      this.declareVictory();
      return;
    }

    this.ctx.log(`bully: challenging ${higher.length} higher node(s)`, "election");

    for (const peer of higher) {
      if (this.ctx.send(peer, ELECTION_BULLY, {})) {
        this.runningCost += 1;
      }
    }

    // If none of them answers, every higher node is down and we take the role.
    this.answerTimer = window.setTimeout(() => {
      this.answerTimer = null;
      if (!this.answered) {
        this.ctx.log("bully: no answer from higher nodes", "election");
        this.declareVictory();
      }
    }, ANSWER_TIMEOUT_MS);
  }

  private onBullyElection(from: NodeId): void {
    // A lower node challenged us. We outrank it, so we answer and run our own election.
    if (this.ctx.send(from, ELECTION_ANSWER, {})) {
      this.runningCost += 1;
    }
    this.ctx.log(`bully: answered challenge from ${this.ctx.peerName(from)}`, "election");

    if (!this.inProgress) {
      this.start();
    }
  }

  private onBullyAnswer(from: NodeId): void {
    // Someone above us is alive, so we cannot win. Stand down and wait for their result.
    this.answered = true;
    this.clearAnswerTimer();
    this.inProgress = false;
    this.ctx.log(`bully: stood down, ${this.ctx.peerName(from)} outranks us`, "election");
    this.ctx.changed();
  }

  // -------------------------------------------------------------------- ring

  /** The ring is the live membership in ascending id order, closed back on itself. */
  private ring(): NodeId[] {
    return [...this.hooks.liveNodes(), this.ctx.selfId].sort((a, b) => a - b);
  }

  private successorOf(node: NodeId): NodeId | null {
    const ring = this.ring();
    if (ring.length <= 1) {
      return null;
    }
    const index = ring.indexOf(node);
    if (index === -1) {
      return null;
    }
    return ring[(index + 1) % ring.length];
  }

  // [DS-U3-ELECTION-RING] Unit III - Election Algorithms. Chang-Roberts ring, O(n) messages.
  private startRing(): void {
    const successor = this.successorOf(this.ctx.selfId);

    if (successor === null) {
      this.declareVictory();
      return;
    }

    this.ctx.log("ring: forwarding election to successor", "election");
    if (this.ctx.send(successor, ELECTION_RING, { candidates: [this.ctx.selfId] } satisfies RingBody)) {
      this.runningCost += 1;
    }
  }

  private onRingElection(body: RingBody): void {
    const candidates = body.candidates ?? [];

    if (candidates.includes(this.ctx.selfId)) {
      // The message has been all the way round. Highest id in the list wins.
      const winner = candidates.reduce((a, b) => (a > b ? a : b), candidates[0]);
      this.ctx.log(`ring: lap complete, winner is ${this.ctx.peerName(winner)}`, "election");
      this.announceCoordinator(winner);
      return;
    }

    if (!this.inProgress) {
      this.inProgress = true;
      this.startedAt = performance.now();
      this.runningCost = 0;
    }

    const successor = this.successorOf(this.ctx.selfId);
    if (successor === null) {
      this.announceCoordinator(this.ctx.selfId);
      return;
    }

    if (
      this.ctx.send(successor, ELECTION_RING, {
        candidates: [...candidates, this.ctx.selfId],
      } satisfies RingBody)
    ) {
      this.runningCost += 1;
    }
  }

  // ------------------------------------------------------------------ shared

  private declareVictory(): void {
    this.announceCoordinator(this.ctx.selfId);
  }

  private announceCoordinator(winner: NodeId): void {
    const body: CoordinatorBody = { coordinator: winner, algorithm: this.algorithm };
    const sent = this.ctx.broadcast(ELECTION_COORDINATOR, body);
    this.runningCost += sent;

    this.settle(winner);
  }

  private onCoordinatorMessage(body: CoordinatorBody): void {
    this.settle(body.coordinator);
  }

  private settle(winner: NodeId): void {
    this.clearAnswerTimer();

    const changed = this.coordinatorId !== winner;
    this.coordinatorId = winner;
    this.inProgress = false;

    this.lastCost = this.runningCost;
    this.lastLatencyMs = Math.round(performance.now() - this.startedAt);
    this.lastAlgorithm = this.algorithm;

    if (changed) {
      const who = winner === this.ctx.selfId ? "this node" : this.ctx.peerName(winner);
      this.ctx.log(
        `${this.algorithm}: coordinator is ${who} (${this.lastCost} msgs, ${this.lastLatencyMs}ms)`,
        "election",
        "success",
      );
      this.hooks.onCoordinator(winner, this.algorithm);
    }

    this.ctx.changed();
  }

  private clearAnswerTimer(): void {
    if (this.answerTimer !== null) {
      window.clearTimeout(this.answerTimer);
      this.answerTimer = null;
    }
  }

  accept(kind: string, from: NodeId, body: unknown): boolean {
    switch (kind) {
      case ELECTION_BULLY:
        this.onBullyElection(from);
        return true;
      case ELECTION_ANSWER:
        this.onBullyAnswer(from);
        return true;
      case ELECTION_RING:
        this.onRingElection(body as RingBody);
        return true;
      case ELECTION_COORDINATOR:
        this.onCoordinatorMessage(body as CoordinatorBody);
        return true;
      default:
        return false;
    }
  }

  destroy(): void {
    this.clearAnswerTimer();
  }
}
