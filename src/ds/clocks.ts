/**
 * Logical clocks.
 *
 * Unit III: Logical Clocks, Lamport's Algorithm, Vector Algorithm.
 *
 * The document replica itself needs none of this -- Yjs converges without any notion
 * of time. These clocks exist so the coordination algorithms built on top (mutual
 * exclusion, snapshots) can order events, and so the inspector can show that ordering
 * to a human.
 */

import type { CausalOrder, NodeId, VectorClockState } from "./types";

/**
 * Lamport's logical clock.
 *
 * Rules, exactly as Lamport stated them:
 *   1. Before sending a message, increment the local counter.
 *   2. On receiving a message, set the counter to max(local, received) + 1.
 *   3. Before any purely local event, increment the local counter.
 *
 * This gives a consistent partial order: if a happened-before b then L(a) < L(b).
 * The converse does not hold, which is the whole reason vector clocks exist.
 */
// [DS-U3-LAMPORT] Unit III - Logical Clocks, Lamport's Algorithm.
export class LamportClock {
  private counter = 0;

  /** Rule 1 and 3: a local event or a send. Returns the timestamp to stamp it with. */
  tick(): number {
    this.counter += 1;
    return this.counter;
  }

  /** Rule 2: a receive. */
  update(received: number): number {
    this.counter = Math.max(this.counter, received) + 1;
    return this.counter;
  }

  get value(): number {
    return this.counter;
  }
}

/**
 * Vector clock.
 *
 * Unlike Lamport timestamps, vector clocks characterise causality exactly: a happened
 * before b if and only if VC(a) <= VC(b) and VC(a) != VC(b). That "if and only if" is
 * what lets us detect genuine concurrency, which a single integer cannot do.
 */
// [DS-U3-VECTOR] Unit III - Vector Algorithm. One counter per node.
export class VectorClock {
  private state: VectorClockState;
  private readonly self: NodeId;

  constructor(self: NodeId) {
    this.self = self;
    this.state = { [self]: 0 };
  }

  /** A local event or a send: increment only our own component. */
  tick(): VectorClockState {
    this.state[this.self] = (this.state[this.self] ?? 0) + 1;
    return this.snapshot();
  }

  /** A receive: merge componentwise, then increment our own. */
  update(received: VectorClockState): VectorClockState {
    for (const key of Object.keys(received)) {
      const node = Number(key);
      this.state[node] = Math.max(this.state[node] ?? 0, received[node] ?? 0);
    }
    this.state[this.self] = (this.state[this.self] ?? 0) + 1;
    return this.snapshot();
  }

  /** Make sure a newly discovered peer has a component, so comparisons stay total. */
  ensure(node: NodeId): void {
    if (this.state[node] === undefined) {
      this.state[node] = 0;
    }
  }

  snapshot(): VectorClockState {
    return { ...this.state };
  }
}

/**
 * Compare two vector clocks under the happened-before relation.
 *
 * "concurrent" is the interesting answer: it means neither event could have caused the
 * other, which is precisely the situation where the CRDT has to merge and where a lock
 * would have been needed if the application cared about the outcome.
 */
// [DS-U3-VECTOR-COMPARE] Unit III - Vector Algorithm. Exact causality test, detects concurrency.
export function compareVectorClocks(
  a: VectorClockState,
  b: VectorClockState,
): CausalOrder {
  const nodes = new Set<number>([
    ...Object.keys(a).map(Number),
    ...Object.keys(b).map(Number),
  ]);

  let aLessSomewhere = false;
  let bLessSomewhere = false;

  for (const node of nodes) {
    const av = a[node] ?? 0;
    const bv = b[node] ?? 0;

    if (av < bv) {
      aLessSomewhere = true;
    } else if (bv < av) {
      bLessSomewhere = true;
    }
  }

  if (!aLessSomewhere && !bLessSomewhere) {
    return "equal";
  }

  if (aLessSomewhere && !bLessSomewhere) {
    return "before";
  }

  if (bLessSomewhere && !aLessSomewhere) {
    return "after";
  }

  return "concurrent";
}

/**
 * Total order over Lamport timestamps, breaking ties by node id.
 *
 * Lamport's own trick for turning the partial order into a total one. Mutual exclusion
 * needs a total order, otherwise two nodes requesting the same section at the same
 * logical time could both decide they won.
 */
// [DS-U3-LAMPORT-TOTALORDER] Unit III - Lamport's Algorithm. Total order, node id breaks ties.
export function compareLamport(
  aTime: number,
  aNode: NodeId,
  bTime: number,
  bNode: NodeId,
): number {
  if (aTime !== bTime) {
    return aTime - bTime;
  }
  return aNode - bNode;
}

/** Format a vector clock compactly for the inspector, e.g. "{4021:3, 9177:1}". */
export function formatVectorClock(vc: VectorClockState): string {
  const parts = Object.keys(vc)
    .map(Number)
    .sort((a, b) => a - b)
    .map((node) => `${node}:${vc[node]}`);
  return `{${parts.join(", ")}}`;
}
