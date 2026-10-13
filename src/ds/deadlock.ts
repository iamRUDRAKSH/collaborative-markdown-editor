/**
 * Distributed deadlock detection by edge chasing.
 *
 * Unit III (self study): Knapp's classification of distributed deadlock detection.
 *
 * Knapp groups the algorithms into four classes: path-pushing, edge-chasing, diffusion
 * computation, and global-state detection. This is the **edge-chasing** class, and
 * specifically the Chandy-Misra-Haas algorithm for the single-resource model.
 *
 * The deadlock is not contrived. Once sections are independent lockable resources, a node
 * can hold "intro" while waiting for "methods" at the same time as another node holds
 * "methods" while waiting for "intro". Neither can proceed, neither will time out on its
 * own, and no node can see the cycle from its local view -- which is exactly the problem
 * the algorithm exists to solve.
 *
 * The probe carries three ids: who started the hunt, who last forwarded it, and who is
 * being asked. A blocked node forwards the probe to everyone it is waiting on. If a probe
 * ever returns to the node that started it, the wait-for graph contains a cycle.
 *
 * Note the detector can only find cycles among nodes that are *currently* blocked; a probe
 * dies at the first node that is running. That is the correct behaviour -- a running node
 * will eventually release, so there is no deadlock to report.
 */

import type { ServiceContext } from "./context";
import type { NodeId, SectionId, WaitForEdge } from "./types";

export const DEADLOCK_PROBE = "deadlock-probe";

/** How often a blocked node restarts its probes. */
const PROBE_INTERVAL_MS = 3000;

/** How long a node must be blocked before it bothers probing. */
const BLOCKED_GRACE_MS = 2000;

type ProbeBody = {
  /** The node that started this hunt; a probe returning here means a cycle. */
  initiator: NodeId;
  /** The node that forwarded this probe. */
  sender: NodeId;
  /** The node being probed. */
  receiver: NodeId;
  /** Path the probe has taken, for display. Not needed by the algorithm itself. */
  path: NodeId[];
};

export type DeadlockHooks = {
  /** Sections this node is currently blocked on, with the node believed to hold each. */
  waitingFor: () => { section: SectionId; holder: NodeId }[];
  /** Abort a lock request after this node is chosen as the deadlock victim. */
  abort: (section: SectionId) => void;
};

export class DeadlockService {
  private readonly ctx: ServiceContext;
  private readonly hooks: DeadlockHooks;

  private timer: number | null = null;

  /** When each section's wait began, so we only probe after the grace period. */
  private readonly blockedSince = new Map<SectionId, number>();

  /** Edges learned from probes passing through, for the wait-for graph display. */
  private readonly observedEdges = new Map<string, WaitForEdge>();

  private detections = 0;
  private probesSent = 0;
  private lastCycle: NodeId[] | null = null;

  constructor(ctx: ServiceContext, hooks: DeadlockHooks) {
    this.ctx = ctx;
    this.hooks = hooks;
  }

  start(): void {
    if (this.timer === null) {
      this.timer = window.setInterval(() => this.sweep(), PROBE_INTERVAL_MS);
    }
  }

  stop(): void {
    if (this.timer !== null) {
      window.clearInterval(this.timer);
      this.timer = null;
    }
  }

  stats(): { detections: number; probesSent: number; lastCycle: NodeId[] | null } {
    return {
      detections: this.detections,
      probesSent: this.probesSent,
      lastCycle: this.lastCycle,
    };
  }

  /** Every wait-for edge this node currently knows about, local plus observed. */
  graph(): WaitForEdge[] {
    const edges = new Map<string, WaitForEdge>(this.observedEdges);

    for (const wait of this.hooks.waitingFor()) {
      const edge: WaitForEdge = {
        waiter: this.ctx.selfId,
        holder: wait.holder,
        section: wait.section,
      };
      edges.set(`${edge.waiter}->${edge.holder}:${edge.section}`, edge);
    }

    return [...edges.values()];
  }

  private sweep(): void {
    const waits = this.hooks.waitingFor();
    const now = this.ctx.clock.localNow();

    // Forget sections we are no longer blocked on.
    const active = new Set(waits.map((wait) => wait.section));
    for (const section of [...this.blockedSince.keys()]) {
      if (!active.has(section)) {
        this.blockedSince.delete(section);
      }
    }

    for (const wait of waits) {
      const since = this.blockedSince.get(wait.section);

      if (since === undefined) {
        this.blockedSince.set(wait.section, now);
        continue;
      }

      if (now - since < BLOCKED_GRACE_MS) {
        continue;
      }

      // Start a hunt: probe the node holding what we want.
      this.sendProbe(wait.holder, {
        initiator: this.ctx.selfId,
        sender: this.ctx.selfId,
        receiver: wait.holder,
        path: [this.ctx.selfId],
      });
    }
  }

  private sendProbe(to: NodeId, probe: ProbeBody): void {
    if (this.ctx.send(to, DEADLOCK_PROBE, probe)) {
      this.probesSent += 1;
    }
  }

  accept(kind: string, from: NodeId, body: unknown): boolean {
    if (kind !== DEADLOCK_PROBE) {
      return false;
    }

    const probe = body as ProbeBody;

    // Remember the edge the probe travelled along, so the inspector can draw the graph.
    const edgeKey = `${probe.sender}->${probe.receiver}`;
    this.observedEdges.set(edgeKey, {
      waiter: probe.sender,
      holder: probe.receiver,
      section: "(probed)",
    });

    if (probe.initiator === this.ctx.selfId) {
      // The probe came back to us: every node on the path is blocked waiting on the next.
      this.onDeadlock(probe);
      return true;
    }

    const waits = this.hooks.waitingFor();

    if (waits.length === 0) {
      // We are not blocked, so the chain ends here. No cycle through this node.
      return true;
    }

    // Blocked: keep the hunt going towards everyone we are waiting on.
    for (const wait of waits) {
      this.sendProbe(wait.holder, {
        initiator: probe.initiator,
        sender: this.ctx.selfId,
        receiver: wait.holder,
        path: [...probe.path, this.ctx.selfId],
      });
    }

    this.ctx.log(
      `forwarded deadlock probe from ${this.ctx.peerName(from)} (initiator ${probe.initiator})`,
      "deadlock",
    );

    return true;
  }

  private onDeadlock(probe: ProbeBody): void {
    this.detections += 1;
    this.lastCycle = [...probe.path, this.ctx.selfId];

    const cycle = this.lastCycle.join(" -> ");
    this.ctx.log(`DEADLOCK detected, cycle: ${cycle}`, "deadlock", "warn");

    /**
     * Victim selection. The node that detected the cycle aborts its own request, which is
     * simple and guarantees progress. It is not fair -- a node that probes first is always
     * the one that loses -- and a production system would pick the victim by cost or age.
     */
    const waits = this.hooks.waitingFor();
    const victim = waits[0];

    if (victim) {
      this.ctx.log(`aborting own request for ${victim.section} to break the cycle`, "deadlock", "warn");
      this.hooks.abort(victim.section);
      this.blockedSince.delete(victim.section);
    }

    this.ctx.changed();
  }

  destroy(): void {
    this.stop();
    this.blockedSince.clear();
    this.observedEdges.clear();
  }
}
