/**
 * Distributed mutual exclusion over document sections.
 *
 * Unit III: Mutual Exclusion Algorithms.
 * Unit III (self study): Lodha and Kshemkalyani's fair mutual exclusion.
 *
 * Why this exists at all: the Yjs CRDT from FA-1 converges without coordination, which
 * means it can merge anything but can guarantee nothing. "Only one person may restructure
 * this section at a time" is not a property a CRDT can express. It needs a real critical
 * section, and that is what forces every algorithm below.
 *
 * Each document section is an independent resource, so a node can hold one while waiting
 * for another -- which is precisely how the distributed deadlock in deadlock.ts arises.
 *
 * Five algorithms behind one API, selectable at runtime:
 *
 *   centralized        3 messages   request / grant / release via the elected coordinator
 *   lamport            3(n-1)       request queue + replies + explicit releases
 *   ricart-agrawala    2(n-1)       replies deferred instead of a release broadcast
 *   token-ring         1..infinity  token circulates; cost is independent of demand
 *   lodha-kshemkalyani 2(n-1)       Ricart-Agrawala plus a fairness concession rule
 *
 * The inspector records messages and latency per cycle so the costs can be compared
 * against those bounds live rather than quoted from a slide.
 */

import type { ServiceContext } from "./context";
import { compareLamport } from "./clocks";
import type { LockEntry, MessageCost, MutexAlgorithm, NodeId, SectionId } from "./types";

export const MUTEX_REQUEST = "mutex-request";
export const MUTEX_REPLY = "mutex-reply";
export const MUTEX_RELEASE = "mutex-release";
export const MUTEX_GRANT = "mutex-grant";
export const MUTEX_TOKEN = "mutex-token";

/** How long a node waits for a token before assuming it was lost with a failed peer. */
const TOKEN_TIMEOUT_MS = 8000;

type RequestBody = { section: SectionId; ts: number };
type ReplyBody = { section: SectionId; ts: number };
type ReleaseBody = { section: SectionId; ts: number };
type GrantBody = { section: SectionId };
type TokenBody = { section: SectionId; holder: NodeId };

type QueueEntry = { node: NodeId; ts: number };

type SectionState = {
  section: SectionId;
  phase: "idle" | "requesting" | "held";
  /** Lamport timestamp of our outstanding request. */
  myTs: number;
  /** Peers whose reply we are still waiting for. */
  awaiting: Set<NodeId>;
  /** Peers we owe a reply to once we leave the critical section. */
  deferred: NodeId[];
  /** Lamport's algorithm keeps an explicit ordered request queue. */
  queue: QueueEntry[];
  /** Token-ring: do we currently hold this section's token? */
  hasToken: boolean;
  /** Token-ring: when we last saw the token, to detect loss. */
  tokenSeenAt: number;
  /** Resolve/reject of the caller awaiting entry. */
  resolve: (() => void) | null;
  reject: ((error: Error) => void) | null;
  /** Measurement for the current cycle. */
  messages: number;
  startedAt: number;
};

export type MutexHooks = {
  coordinator: () => NodeId | null;
  isCoordinator: () => boolean;
  liveNodes: () => NodeId[];
  /** Fired when the set of held locks changes, so the editor can enable/disable regions. */
  onLocksChanged: () => void;
};

export class MutexService {
  private readonly ctx: ServiceContext;
  private readonly hooks: MutexHooks;

  private algorithm: MutexAlgorithm = "centralized";

  private readonly sections = new Map<SectionId, SectionState>();

  /** Who we believe holds each section. Learned locally and from beacon gossip. */
  private readonly holders = new Map<SectionId, LockEntry>();

  /** Coordinator-side state, used only under the centralized algorithm. */
  private readonly centralOwner = new Map<SectionId, NodeId>();
  private readonly centralQueue = new Map<SectionId, NodeId[]>();

  /** Completed cycles, for the algorithm comparison table. */
  private readonly costs: MessageCost[] = [];

  /**
   * Fairness concession (Lodha-Kshemkalyani variant): sections for which we must let the
   * nodes that were already waiting go ahead before we request again.
   */
  private readonly concede = new Set<SectionId>();

  private tokenTimer: number | null = null;

  constructor(ctx: ServiceContext, hooks: MutexHooks) {
    this.ctx = ctx;
    this.hooks = hooks;
  }

  start(): void {
    if (this.tokenTimer === null) {
      this.tokenTimer = window.setInterval(() => this.checkTokenLoss(), 2000);
    }
  }

  setAlgorithm(algorithm: MutexAlgorithm): void {
    this.algorithm = algorithm;
    this.ctx.log(`mutual exclusion algorithm set to ${algorithm}`, "mutex");
    this.ctx.changed();
  }

  get currentAlgorithm(): MutexAlgorithm {
    return this.algorithm;
  }

  /** Expected message cost for the current algorithm, for display beside the measurement. */
  expectedCost(peers: number): string {
    switch (this.algorithm) {
      case "centralized":
        return "3";
      case "lamport":
        return `3(n-1) = ${3 * peers}`;
      case "ricart-agrawala":
      case "lodha-kshemkalyani":
        return `2(n-1) = ${2 * peers}`;
      case "token-ring":
        return "1 per hop";
    }
  }

  lockTable(): LockEntry[] {
    return [...this.holders.values()].sort((a, b) => a.section.localeCompare(b.section));
  }

  costHistory(): MessageCost[] {
    return [...this.costs].slice(-12).reverse();
  }

  holderOf(section: SectionId): NodeId | null {
    return this.holders.get(section)?.holder ?? null;
  }

  heldByMe(section: SectionId): boolean {
    return this.holders.get(section)?.holder === this.ctx.selfId;
  }

  /** Sections we are currently blocked waiting for, for the wait-for graph. */
  waitingFor(): { section: SectionId; holder: NodeId }[] {
    const waits: { section: SectionId; holder: NodeId }[] = [];
    for (const state of this.sections.values()) {
      if (state.phase !== "requesting") {
        continue;
      }
      const holder = this.holders.get(state.section)?.holder;
      if (holder !== undefined && holder !== this.ctx.selfId) {
        waits.push({ section: state.section, holder });
      }
    }
    return waits;
  }

  /** Learn lock state gossiped on a beacon. */
  mergeRemoteLocks(from: NodeId, locks: LockEntry[]): void {
    for (const lock of locks) {
      const known = this.holders.get(lock.section);
      // A later Lamport grant supersedes an earlier belief.
      if (!known || lock.grantedAt > known.grantedAt) {
        this.holders.set(lock.section, lock);
      }
    }

    // A section this peer no longer reports, and that we believed it held, was released.
    for (const [section, entry] of [...this.holders.entries()]) {
      if (entry.holder === from && !locks.some((lock) => lock.section === section)) {
        this.holders.delete(section);
      }
    }

    this.hooks.onLocksChanged();
  }

  /** Release anything a failed node was holding, so the section is not stranded. */
  onPeerDown(peer: NodeId): void {
    for (const [section, entry] of [...this.holders.entries()]) {
      if (entry.holder === peer) {
        this.holders.delete(section);
        this.ctx.log(`released ${section} stranded by failed node ${peer}`, "mutex", "warn");
      }
    }

    // Coordinator-side cleanup under the centralized algorithm.
    for (const [section, owner] of [...this.centralOwner.entries()]) {
      if (owner === peer) {
        this.centralOwner.delete(section);
        this.grantNextCentral(section);
      }
    }
    for (const [section, queue] of this.centralQueue.entries()) {
      this.centralQueue.set(
        section,
        queue.filter((node) => node !== peer),
      );
    }

    // Stop waiting on replies that will never arrive.
    for (const state of this.sections.values()) {
      if (state.awaiting.delete(peer)) {
        this.maybeEnter(state);
      }
    }

    this.hooks.onLocksChanged();
    this.ctx.changed();
  }

  // ------------------------------------------------------------ public API

  /** Enter the critical section for a document section. */
  async acquire(section: SectionId): Promise<void> {
    const state = this.stateFor(section);

    if (state.phase === "held") {
      return;
    }

    if (state.phase === "requesting") {
      throw new Error(`already requesting ${section}`);
    }

    if (this.concede.has(section)) {
      // Fairness rule: we recently held this section and others are queued behind us.
      this.ctx.log(`conceding ${section} -- waiting nodes go first`, "mutex", "warn");
      this.concede.delete(section);
    }

    state.phase = "requesting";
    state.messages = 0;
    state.startedAt = performance.now();
    state.myTs = this.ctx.lamport.tick();
    this.ctx.vc.tick();

    const entry = new Promise<void>((resolve, reject) => {
      state.resolve = resolve;
      state.reject = reject;
    });

    switch (this.algorithm) {
      case "centralized":
        this.requestCentral(state);
        break;
      case "lamport":
        this.requestLamport(state);
        break;
      case "ricart-agrawala":
      case "lodha-kshemkalyani":
        this.requestRicartAgrawala(state);
        break;
      case "token-ring":
        this.requestToken(state);
        break;
    }

    this.ctx.changed();
    return entry;
  }

  /**
   * Give up an outstanding request without having entered.
   *
   * Used when the deadlock detector picks this node as the victim. Any replies we owe are
   * released immediately, otherwise aborting here would leave other nodes blocked forever
   * on a request we no longer care about.
   */
  abort(section: SectionId): void {
    const state = this.sections.get(section);
    if (!state || state.phase !== "requesting") {
      return;
    }

    state.phase = "idle";
    state.awaiting.clear();
    state.queue = state.queue.filter((entry) => entry.node !== this.ctx.selfId);

    for (const peer of state.deferred.splice(0)) {
      if (this.ctx.send(peer, MUTEX_REPLY, { section, ts: this.ctx.lamport.value })) {
        this.ctx.countMessage(1);
      }
    }

    if (this.algorithm === "lamport") {
      this.ctx.broadcast(MUTEX_RELEASE, { section, ts: this.ctx.lamport.value } satisfies ReleaseBody);
    }

    state.reject?.(new Error(`request for ${section} aborted to break a deadlock`));
    state.resolve = null;
    state.reject = null;

    this.ctx.changed();
  }

  /** Leave the critical section. */
  release(section: SectionId): void {
    const state = this.sections.get(section);
    if (!state || state.phase !== "held") {
      return;
    }

    state.phase = "idle";
    this.holders.delete(section);
    this.ctx.lamport.tick();
    this.ctx.vc.tick();

    switch (this.algorithm) {
      case "centralized":
        this.releaseCentral(state);
        break;
      case "lamport":
        this.releaseLamport(state);
        break;
      case "ricart-agrawala":
      case "lodha-kshemkalyani":
        this.releaseRicartAgrawala(state);
        break;
      case "token-ring":
        this.releaseToken(state);
        break;
    }

    this.ctx.log(`released ${section}`, "mutex", "success");
    this.hooks.onLocksChanged();
    this.ctx.changed();
  }

  // ------------------------------------------------------------- centralized

  /**
   * Centralized: ask the elected coordinator. Three messages per cycle regardless of
   * group size, which is the cheapest of the five -- paid for with a single point of
   * failure that only exists because an election can replace it.
   */
  // [DS-U3-MUTEX-CENTRALIZED] Unit III - Mutual Exclusion. Centralized, 3 messages per entry.
  private requestCentral(state: SectionState): void {
    const coordinator = this.hooks.coordinator();

    if (coordinator === null) {
      this.fail(state, new Error("no coordinator elected yet"));
      return;
    }

    if (coordinator === this.ctx.selfId) {
      // We are the coordinator; decide locally without any message at all.
      const owner = this.centralOwner.get(state.section);
      if (owner === undefined) {
        this.centralOwner.set(state.section, this.ctx.selfId);
        this.enter(state);
      } else {
        const queue = this.centralQueue.get(state.section) ?? [];
        queue.push(this.ctx.selfId);
        this.centralQueue.set(state.section, queue);
      }
      return;
    }

    if (this.ctx.send(coordinator, MUTEX_REQUEST, { section: state.section, ts: state.myTs })) {
      state.messages += 1;
      this.ctx.countMessage(1);
    } else {
      this.fail(state, new Error("coordinator unreachable"));
    }
  }

  private releaseCentral(state: SectionState): void {
    const coordinator = this.hooks.coordinator();
    if (coordinator === null) {
      return;
    }

    if (coordinator === this.ctx.selfId) {
      this.centralOwner.delete(state.section);
      this.grantNextCentral(state.section);
      return;
    }

    if (this.ctx.send(coordinator, MUTEX_RELEASE, { section: state.section, ts: state.myTs })) {
      state.messages += 1;
      this.ctx.countMessage(1);
    }
    this.recordCost(state);
  }

  /** Coordinator side: hand the section to the next node in the queue. */
  private grantNextCentral(section: SectionId): void {
    const queue = this.centralQueue.get(section) ?? [];
    const next = queue.shift();
    this.centralQueue.set(section, queue);

    if (next === undefined) {
      return;
    }

    this.centralOwner.set(section, next);

    if (next === this.ctx.selfId) {
      const state = this.stateFor(section);
      this.enter(state);
      return;
    }

    if (this.ctx.send(next, MUTEX_GRANT, { section } satisfies GrantBody)) {
      this.ctx.countMessage(1);
    }
  }

  private onCentralRequest(from: NodeId, body: RequestBody): void {
    if (!this.hooks.isCoordinator()) {
      // Not ours to answer. The requester will retry against the new coordinator.
      return;
    }

    const owner = this.centralOwner.get(body.section);

    if (owner === undefined) {
      this.centralOwner.set(body.section, from);
      if (this.ctx.send(from, MUTEX_GRANT, { section: body.section } satisfies GrantBody)) {
        this.ctx.countMessage(1);
      }
      return;
    }

    const queue = this.centralQueue.get(body.section) ?? [];
    if (!queue.includes(from)) {
      queue.push(from);
    }
    this.centralQueue.set(body.section, queue);
  }

  private onCentralRelease(from: NodeId, body: ReleaseBody): void {
    if (!this.hooks.isCoordinator()) {
      return;
    }
    if (this.centralOwner.get(body.section) === from) {
      this.centralOwner.delete(body.section);
      this.grantNextCentral(body.section);
    }
  }

  private onGrant(body: GrantBody): void {
    const state = this.sections.get(body.section);
    if (state && state.phase === "requesting") {
      state.messages += 1;
      this.enter(state);
    }
  }

  // ----------------------------------------------------------------- Lamport

  /**
   * Lamport's algorithm. Every node keeps the full request queue, so entry needs both
   * conditions: our request must be at the head of the queue, and we must have heard from
   * every other node at a later timestamp (which the replies provide). Releases are
   * broadcast explicitly, which is the extra (n-1) messages over Ricart-Agrawala.
   */
  // [DS-U3-MUTEX-LAMPORT] Unit III - Mutual Exclusion. Lamport's algorithm, 3(n-1) messages.
  private requestLamport(state: SectionState): void {
    const peers = this.hooks.liveNodes();

    state.queue = [{ node: this.ctx.selfId, ts: state.myTs }];
    state.awaiting = new Set(peers);

    const sent = this.ctx.broadcast(MUTEX_REQUEST, {
      section: state.section,
      ts: state.myTs,
    } satisfies RequestBody);

    state.messages += sent;
    this.ctx.countMessage(sent);

    this.maybeEnter(state);
  }

  private releaseLamport(state: SectionState): void {
    state.queue = state.queue.filter((entry) => entry.node !== this.ctx.selfId);

    const sent = this.ctx.broadcast(MUTEX_RELEASE, {
      section: state.section,
      ts: this.ctx.lamport.value,
    } satisfies ReleaseBody);

    state.messages += sent;
    this.ctx.countMessage(sent);
    this.recordCost(state);
  }

  private onLamportRequest(from: NodeId, body: RequestBody): void {
    const state = this.stateFor(body.section);

    state.queue.push({ node: from, ts: body.ts });
    state.queue.sort((a, b) => compareLamport(a.ts, a.node, b.ts, b.node));

    // Lamport's algorithm replies to every request unconditionally.
    if (this.ctx.send(from, MUTEX_REPLY, { section: body.section, ts: this.ctx.lamport.value })) {
      this.ctx.countMessage(1);
    }

    this.maybeEnter(state);
  }

  private onLamportRelease(from: NodeId, body: ReleaseBody): void {
    const state = this.stateFor(body.section);
    state.queue = state.queue.filter((entry) => entry.node !== from);
    this.maybeEnter(state);
  }

  // --------------------------------------------------- Ricart-Agrawala family

  /**
   * Ricart-Agrawala. A node replies at once unless it is in the critical section or has
   * an outstanding request that outranks the incoming one; otherwise the reply is
   * deferred until release. Deferring is what removes the release broadcast and takes the
   * cost from 3(n-1) down to 2(n-1).
   */
  // [DS-U3-MUTEX-RICART-AGRAWALA] Unit III - Mutual Exclusion. Ricart-Agrawala, 2(n-1) messages.
  private requestRicartAgrawala(state: SectionState): void {
    const peers = this.hooks.liveNodes();
    state.awaiting = new Set(peers);

    const sent = this.ctx.broadcast(MUTEX_REQUEST, {
      section: state.section,
      ts: state.myTs,
    } satisfies RequestBody);

    state.messages += sent;
    this.ctx.countMessage(sent);

    this.maybeEnter(state);
  }

  // [DS-U3-MUTEX-FAIR] Unit III self study - Lodha-Kshemkalyani fairness concession rule.
  private releaseRicartAgrawala(state: SectionState): void {
    const deferred = state.deferred.splice(0);

    for (const peer of deferred) {
      if (this.ctx.send(peer, MUTEX_REPLY, { section: state.section, ts: this.ctx.lamport.value })) {
        state.messages += 1;
        this.ctx.countMessage(1);
      }
    }

    /**
     * Fairness concession. Plain Ricart-Agrawala lets a node that releases immediately
     * re-request and, with a low id, keep winning ties -- so a node can be starved. The
     * fair variant forbids re-entry until the nodes that were already deferred have had
     * their turn. This preserves the request/reply skeleton and the bounded-waiting
     * property of Lodha and Kshemkalyani's algorithm; their published version reaches it
     * with a more elaborate request-set scheme and fewer messages than this does.
     */
    if (this.algorithm === "lodha-kshemkalyani" && deferred.length > 0) {
      this.concede.add(state.section);
    }

    this.recordCost(state);
  }

  private onRicartAgrawalaRequest(from: NodeId, body: RequestBody): void {
    const state = this.stateFor(body.section);

    const inCriticalSection = state.phase === "held";
    const outranksIncoming =
      state.phase === "requesting" &&
      compareLamport(state.myTs, this.ctx.selfId, body.ts, from) < 0;

    if (inCriticalSection || outranksIncoming) {
      state.deferred.push(from);
      this.ctx.log(`deferred reply to ${this.ctx.peerName(from)} for ${body.section}`, "mutex");
      return;
    }

    if (this.ctx.send(from, MUTEX_REPLY, { section: body.section, ts: this.ctx.lamport.value })) {
      this.ctx.countMessage(1);
    }
  }

  // ------------------------------------------------------------- token ring

  /**
   * Token ring. Holding the token *is* holding the right to enter, so there is no
   * request message at all -- the cost is one message per hop whether or not anyone wants
   * the section, which is the algorithm's defining trade-off.
   *
   * Token loss is its classic failure mode: if the holder crashes, the token vanishes.
   * We detect that with a timeout and let the lowest live id regenerate it.
   */
  // [DS-U3-MUTEX-TOKEN-RING] Unit III - Mutual Exclusion. Token ring, one message per hop.
  private requestToken(state: SectionState): void {
    if (state.hasToken) {
      this.enter(state);
      return;
    }

    const ring = this.ring();
    if (ring.length <= 1) {
      state.hasToken = true;
      state.tokenSeenAt = this.ctx.clock.localNow();
      this.enter(state);
      return;
    }

    // Nothing to send: we wait for the token to reach us on its circuit. If no token
    // exists yet, the lowest id mints one.
    if (this.lowestLiveId() === this.ctx.selfId && state.tokenSeenAt === 0) {
      this.ctx.log(`minting token for ${state.section}`, "mutex");
      state.hasToken = true;
      state.tokenSeenAt = this.ctx.clock.localNow();
      this.enter(state);
    }
  }

  private releaseToken(state: SectionState): void {
    this.passToken(state);
    this.recordCost(state);
  }

  private passToken(state: SectionState): void {
    const ring = this.ring();
    if (ring.length <= 1) {
      return;
    }

    const index = ring.indexOf(this.ctx.selfId);
    const next = ring[(index + 1) % ring.length];

    state.hasToken = false;

    if (
      this.ctx.send(next, MUTEX_TOKEN, {
        section: state.section,
        holder: next,
      } satisfies TokenBody)
    ) {
      state.messages += 1;
      this.ctx.countMessage(1);
    }
  }

  private onToken(body: TokenBody): void {
    const state = this.stateFor(body.section);
    state.hasToken = true;
    state.tokenSeenAt = this.ctx.clock.localNow();

    if (state.phase === "requesting") {
      this.enter(state);
    } else if (this.algorithm === "token-ring") {
      // Not wanted here; keep it moving so the next node is not blocked.
      window.setTimeout(() => {
        if (state.phase !== "held" && state.hasToken) {
          this.passToken(state);
        }
      }, 250);
    }
  }

  private checkTokenLoss(): void {
    if (this.algorithm !== "token-ring") {
      return;
    }

    const now = this.ctx.clock.localNow();

    for (const state of this.sections.values()) {
      if (
        state.phase === "requesting" &&
        !state.hasToken &&
        state.tokenSeenAt > 0 &&
        now - state.tokenSeenAt > TOKEN_TIMEOUT_MS &&
        this.lowestLiveId() === this.ctx.selfId
      ) {
        this.ctx.log(`token for ${state.section} presumed lost -- regenerating`, "mutex", "warn");
        state.hasToken = true;
        state.tokenSeenAt = now;
        this.enter(state);
      }
    }
  }

  private ring(): NodeId[] {
    return [...this.hooks.liveNodes(), this.ctx.selfId].sort((a, b) => a - b);
  }

  private lowestLiveId(): NodeId {
    return this.ring()[0];
  }

  // ----------------------------------------------------------------- shared

  private stateFor(section: SectionId): SectionState {
    let state = this.sections.get(section);
    if (!state) {
      state = {
        section,
        phase: "idle",
        myTs: 0,
        awaiting: new Set(),
        deferred: [],
        queue: [],
        hasToken: false,
        tokenSeenAt: 0,
        resolve: null,
        reject: null,
        messages: 0,
        startedAt: 0,
      };
      this.sections.set(section, state);
    }
    return state;
  }

  /** Entry test for the reply-counting algorithms. */
  private maybeEnter(state: SectionState): void {
    if (state.phase !== "requesting") {
      return;
    }

    if (state.awaiting.size > 0) {
      return;
    }

    if (this.algorithm === "lamport") {
      // Lamport also requires our request to be at the head of the shared queue.
      const head = state.queue[0];
      if (!head || head.node !== this.ctx.selfId) {
        return;
      }
    }

    this.enter(state);
  }

  private enter(state: SectionState): void {
    state.phase = "held";

    this.holders.set(state.section, {
      section: state.section,
      holder: this.ctx.selfId,
      grantedAt: this.ctx.lamport.value,
    });

    this.ctx.log(
      `entered critical section for ${state.section} (${state.messages} msgs)`,
      "mutex",
      "success",
    );

    state.resolve?.();
    state.resolve = null;
    state.reject = null;

    this.hooks.onLocksChanged();
    this.ctx.changed();
  }

  private fail(state: SectionState, error: Error): void {
    state.phase = "idle";
    state.reject?.(error);
    state.resolve = null;
    state.reject = null;
    this.ctx.log(`lock request for ${state.section} failed: ${error.message}`, "mutex", "warn");
    this.ctx.changed();
  }

  private recordCost(state: SectionState): void {
    this.costs.push({
      algorithm: this.algorithm,
      messages: state.messages,
      peers: this.hooks.liveNodes().length,
      latencyMs: Math.round(performance.now() - state.startedAt),
    });
    state.messages = 0;
  }

  // -------------------------------------------------------------- dispatch

  accept(kind: string, from: NodeId, body: unknown): boolean {
    switch (kind) {
      case MUTEX_REQUEST: {
        const request = body as RequestBody;
        if (this.algorithm === "centralized") {
          this.onCentralRequest(from, request);
        } else if (this.algorithm === "lamport") {
          this.onLamportRequest(from, request);
        } else {
          this.onRicartAgrawalaRequest(from, request);
        }
        return true;
      }

      case MUTEX_REPLY: {
        const reply = body as ReplyBody;
        const state = this.stateFor(reply.section);
        state.awaiting.delete(from);
        this.maybeEnter(state);
        return true;
      }

      case MUTEX_RELEASE: {
        const release = body as ReleaseBody;
        if (this.algorithm === "centralized") {
          this.onCentralRelease(from, release);
        } else {
          this.onLamportRelease(from, release);
        }
        return true;
      }

      case MUTEX_GRANT:
        this.onGrant(body as GrantBody);
        return true;

      case MUTEX_TOKEN:
        this.onToken(body as TokenBody);
        return true;

      default:
        return false;
    }
  }

  destroy(): void {
    if (this.tokenTimer !== null) {
      window.clearInterval(this.tokenTimer);
      this.tokenTimer = null;
    }
    for (const state of this.sections.values()) {
      state.reject?.(new Error("node shutting down"));
    }
    this.sections.clear();
  }
}
