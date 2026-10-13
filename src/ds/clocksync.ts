/**
 * Physical clock synchronisation.
 *
 * Unit III: Clock Synchronization.
 *
 * Two algorithms, because they answer different questions:
 *
 *   Cristian's  -- "what is the offset between my clock and that peer's?"  Passive,
 *                  per-pair, derived from a request/response round trip.
 *   Berkeley's  -- "what time should we all agree it is?"  Active, coordinator-driven,
 *                  averages the group and hands out per-node adjustments. Notably it
 *                  does not need an external time source.
 *
 * This also motivates the rest of Unit III. Run the inspector with two browsers and the
 * measured offset is rarely zero, which is the concrete reason the ordering algorithms
 * below use Lamport and vector clocks rather than wall-clock timestamps.
 */

import type { NodeId } from "./types";

/** The four timestamps of one round trip, in the usual NTP naming. */
export type TimeSample = {
  /** Request left the client. */
  t1: number;
  /** Request arrived at the server, by the server's clock. */
  t2: number;
  /** Response left the server, by the server's clock. */
  t3: number;
  /** Response arrived back at the client. */
  t4: number;
};

export type CristianResult = {
  /** Round-trip time with the server's processing time removed. */
  rttMs: number;
  /**
   * How far ahead the server's clock is relative to ours, in ms.
   * Positive means the remote clock reads later than ours.
   */
  offsetMs: number;
};

/**
 * Cristian's algorithm.
 *
 * The estimate assumes the outbound and inbound legs take the same time, so the remote
 * timestamp is treated as having been taken at the midpoint of the round trip. That
 * assumption is also the algorithm's weakness: an asymmetric path biases the offset by
 * half the asymmetry, which is why the inspector shows the RTT alongside the offset --
 * a large RTT means a correspondingly untrustworthy offset.
 */
export function cristian(sample: TimeSample): CristianResult {
  const rttMs = sample.t4 - sample.t1 - (sample.t3 - sample.t2);
  const offsetMs = (sample.t2 - sample.t1 + (sample.t3 - sample.t4)) / 2;
  return { rttMs, offsetMs };
}

/**
 * Berkeley algorithm, coordinator side.
 *
 * The coordinator already knows each peer's offset from the beacon exchange. It averages
 * those offsets together with its own (which is zero by definition, since everything is
 * measured relative to it) and returns the adjustment each node should apply to arrive at
 * the common time.
 *
 * Averaging is what makes this work without an authoritative clock: no node is assumed
 * correct, the group simply converges on its own mean.
 */
export function berkeley(
  offsets: { node: NodeId; offsetMs: number }[],
): { average: number; adjustments: { node: NodeId; adjustmentMs: number }[] } {
  // The coordinator participates as a node with offset 0 relative to itself.
  const all = [0, ...offsets.map((entry) => entry.offsetMs)];
  const average = all.reduce((sum, value) => sum + value, 0) / all.length;

  const adjustments = offsets.map((entry) => ({
    node: entry.node,
    // Each peer must move by however far its own offset sits from the group mean.
    adjustmentMs: average - entry.offsetMs,
  }));

  return { average, adjustments };
}

/**
 * A clock whose readings can be nudged by a Berkeley adjustment.
 *
 * Deliberately never touches the real system clock -- a web page cannot, and a
 * distributed algorithm should not want to. It keeps a correction that is applied when
 * the application asks for "the agreed time".
 */
export class AdjustableClock {
  private adjustmentMs = 0;

  /** Apply a Berkeley correction. Adjustments accumulate across rounds. */
  adjust(deltaMs: number): void {
    this.adjustmentMs += deltaMs;
  }

  get correctionMs(): number {
    return this.adjustmentMs;
  }

  /** Raw local reading, with no correction. */
  localNow(): number {
    return Date.now();
  }

  /** The group's agreed time, as this node currently believes it. */
  now(): number {
    return Date.now() + this.adjustmentMs;
  }

  reset(): void {
    this.adjustmentMs = 0;
  }
}
