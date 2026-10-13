# FA-2 Demonstration Script

Target: **12-15 minutes** of demo, leaving room for individual questioning.

The order below is deliberate. Each step creates the need for the next one, so the
demonstration tells a single story instead of listing features. If you are short on time,
cut from the bottom (sections 8 and 9), never from the middle.

---

## Before the examiner arrives

**Warm the signaling relay.** Render's free tier spins down after ~15 minutes idle, and the
first connection after that fails outright while it boots. Open this in a tab five minutes
before you start:

```
https://ds-signaling.onrender.com/
```

You want to see `okay`. If you see anything else, stop and fix it before demoing.

**Use two different browsers on ONE laptop.** Chrome and Firefox, side by side.

* Two *different browsers* is required: two tabs of the same browser may sync through
  `BroadcastChannel` instead of WebRTC, which weakens the P2P claim.
* **One laptop** is strongly advised: there is no TURN relay configured, so two machines on
  a restrictive campus network may fail to establish a peer connection at all. On one
  machine, ICE uses host candidates and always succeeds. If asked, this is a known
  limitation and you should say so rather than hope.

**Set distinct names.** Enter a different username in each browser. Identity is per-tab, and
election and locks refer to nodes by name.

**Seed the document** with headings so there are sections to lock:

```
# Introduction
Shared opening paragraph.
# Methods
How the system was built.
# Results
What we measured.
```

**Have a fallback ready.** In two terminals, so you can switch in seconds if the deployment
misbehaves:

```
PORT=4444 npm run signaling
npm run dev
```

---

## 0. The thesis (30 seconds, before touching anything)

> "FA-1 built a system that deliberately avoids coordination. A CRDT converges without
> agreement, which is exactly why it can merge anything but guarantee nothing. For FA-2 we
> added one feature a CRDT fundamentally cannot express — exclusive section locks — and
> every Unit III algorithm follows from needing it."

Say this first. It frames everything after it as necessary rather than decorative.

---

## 1. The system and its clocks — *Logical Clocks, Vector Algorithm*

**Do:** Both browsers in the same room. Open the inspector, *Nodes & Clocks* tab.

**Show:** Two node ids. Lamport counters advancing as messages flow. Vector clocks with one
component per node. The peer table's RTT and clock offset.

**Say:** Lamport gives a consistent partial order — if a happened before b then L(a) < L(b),
but not the converse. Vector clocks characterise causality *exactly*, which is what lets us
detect genuine concurrency rather than guess at it.

**Point at:** `src/ds/clocks.ts` — `LamportClock`, `VectorClock`, `compareVectorClocks`.

---

## 2. Physical clocks are skewed — *Clock Synchronization*

**Show:** The "Clock offset" column. It is not zero. The "Clock correction" stat changes as
Berkeley rounds run.

**Say:** Cristian's algorithm derives the offset from the beacon round trip, assuming
symmetric path delay — which is also its weakness, so we show RTT alongside. Berkeley is
different: the coordinator averages the group rather than imposing its own clock, so no node
is assumed correct.

> **This is the answer to "why not just use timestamps?"** The offset is never zero, so
> wall-clock ordering would be wrong. That is why everything else uses logical time.

**Point at:** `src/ds/clocksync.ts:52` and `:69`.

---

## 3. Mutual exclusion — *the centrepiece*

**Do:** In browser A, inspector → *Mutual Exclusion* → lock **Introduction**.
Then in browser B, click into the Introduction text and type.

**Show:** The edit is **rejected**. Character count does not move. A banner appears.
Then edit **Methods** in browser B — that one propagates normally.

**Say:** The CRDT would happily merge both. The lock only means something because the editor
refuses the transaction. This is enforcement among cooperating nodes — a modified client
could still write, and nothing in a peer-to-peer CRDT can stop it.

**Then switch algorithms** in the dropdown and lock/release again with each:

| Algorithm | Expect |
| --------- | ------ |
| Centralized | 3 messages regardless of group size |
| Lamport | 3(n−1) |
| Ricart-Agrawala | 2(n−1) — replies deferred instead of a release broadcast |
| Token ring | 1 per hop, whether or not anyone wants it |

**Show:** The *Measured cost* table, against the stated bound.

**Say:** Ricart-Agrawala saves the release broadcast by deferring replies. Centralized is
cheapest but needs a coordinator — which is what the next section is about.

**Point at:** `src/ds/mutex.ts:351`, `:472`, `:530`, `:599`.

---

## 4. Election — *because the coordinator can die*

**Do:** *Nodes & Clocks* → note which node is coordinator → **close that browser entirely**.

**Show:** Within ~6 seconds, in the surviving browser's *Event Log*:

```
peer node-XXXX disconnected
coordinator node-XXXX is down -- starting election
bully: coordinator is this node
released <section> stranded by failed node XXXX
```

**Say:** The failure detector is the beacon protocol — missed beacons, not an error message.
It is *unreliable* in the formal sense: a slow network is indistinguishable from a crash, so
a live coordinator can be wrongly replaced. The election tolerates that; it simply loses an
election it would have won.

Note the last line too: locks held by the dead node are released, otherwise the section would
be stranded forever.

**Then** switch to **Ring** and force an election. Compare message counts: Bully is O(n²)
with one round trip, ring is O(n) with latency proportional to ring length. Same winner,
different cost.

**Point at:** `src/ds/election.ts:142` and `:209`, `src/ds/beacon.ts`.

> **Caveat to volunteer:** "beacon protocol" is not standard Kshemkalyani terminology. We
> implemented it as a periodic liveness beacon. If you mean something more specific, please
> say — it is about eighty lines and easy to adjust.

---

## 5. Deadlock — *the consequence of multiple locks*

**Do:** Bring the closed browser back. Then:

1. Browser A locks **Introduction**
2. Browser B locks **Methods**
3. Browser A clicks *Request (queue)* on **Methods**
4. Browser B clicks *Request (queue)* on **Introduction**

**Wait ~6 seconds.** Inspector → *Deadlock* tab.

**Show:**

```
DEADLOCK detected, cycle: AAAA -> BBBB -> AAAA
aborting own request for methods to break the cycle
```

Plus the wait-for graph and the probe count.

**Say:** This is edge chasing — Chandy-Misra-Haas, the edge-chasing class in Knapp's
classification. A blocked node probes whoever holds what it wants; blocked receivers forward
it on. A probe returning to its initiator proves a cycle. Note no node could see the cycle
from its local view — that is the whole problem.

The deadlock is not contrived: it exists *because* sections are independent resources, which
is a direct consequence of the feature in section 3.

**Point at:** `src/ds/deadlock.ts:54`, `:198`.

---

## 6. Global state — *fixing FA-1's weakest claim*

**Do:** Have one person typing continuously. The other presses **Take snapshot** twice.

**Show:** Each snapshot: `COMPLETE`, two node states, and **messages in flight** greater than
zero. The second snapshot's `prev` hash equals the first's hash.

**Say:** FA-1 displayed a SHA-256 of the local document and called it a convergence check.
That was honest but it was *not* a global state — each node hashed itself at its own moment
and nothing recorded the channels. This is Chandy-Lamport: markers on every outgoing channel,
local state recorded on the first marker, channel contents recorded until the marker arrives
on that channel. The result is a consistent cut — a state the system could genuinely have
passed through, though no node ever observed it.

The chained hashes are the Unit IV blockchain self-study: a tamper-evident history, which
buys integrity of the record without paying for consensus.

**Point at:** `src/ds/snapshot.ts:104`, `hashSnapshot`.

---

## 7. Distributed file system — *Unit IV*

**Do:** *File Store* tab → upload a small file. Then **close the other browser** and press
**Download**.

**Show:** The file reassembles and passes its integrity check despite a peer being gone.
Chunk count and replication factor are displayed.

**Say:** 64 KB chunks, content-addressed by SHA-256 so verification is free — the id *is* the
expected hash. Replication factor 2, chunk map on the elected coordinator, re-replication
driven by the same beacon failure detector. It is HDFS in miniature: NameNode becomes the
coordinator, DataNodes become peers, heartbeats become beacons.

Honest limit: every replica is a browser tab, so durability is bounded by how many stay open.

**Point at:** `src/ds/store.ts:41`.

---

## 8. Multimedia and QoS — *Units I and II*

**Do:** *Media & QoS* tab → **Start camera & mic**. Accept the permission prompt.

**Show:** Video tiles. The QoS table: RTT, jitter, packet loss, bitrate, candidate pair.

**Say:** The media tracks ride the *same* peer connections as the coordination data channel —
adding a track triggers renegotiation over the offer/answer exchange we already drive
ourselves. Note jitter and loss only appear on the media stream: SCTP data channels are
reliable and ordered, so they report no loss by construction. That contrast is the difference
between a reliable stream and a real-time one.

**Point at:** `src/ds/qos.ts:46`, `src/ds/transport.ts` → `addLocalStream`.

---

## 9. Close by naming the limitations

Do not wait to be caught. Say these:

* Lock enforcement is **cooperative** — a modified client could bypass it.
* The failure detector is **unreliable** — slow is indistinguishable from dead.
* Token ring **loses its token** if the holder crashes; the lowest live id regenerates it
  after a timeout, which can briefly admit two holders.
* The mesh is **O(n²)** and unsuitable for large groups. The route past it is an SFU, a
  superpeer tier, or a structured overlay.
* **No TURN relay**, so a restrictive network can prevent connection entirely.
* Consensus, quorum and distributed commit are **absent by design** — a CRDT converges
  without agreement; the price is that no global invariant can be enforced.

---

## Contingencies

| Symptom | Cause | Fix |
| ------- | ----- | --- |
| Room appears empty, no peers | Render instance cold | Wait 60 s and reload. Warm it beforehand. |
| Document syncs, inspector shows 0 peers | Yjs mesh up, coordination mesh down | Check DevTools → WS for the signaling URL actually in use |
| WS connects to `localhost:4444` | Frontend built before the env var was set | Redeploy the static site |
| Peers never connect at all | No TURN, restrictive network | Put both browsers on one laptop |
| Everything is broken | — | Switch to localhost: `PORT=4444 npm run signaling` + `npm run dev` |

---

## Splitting it between two people

Both of you will be questioned individually, so neither should own a half exclusively. For
the demo itself:

* **Driver A** runs browser 1, performs the lock/snapshot/upload actions.
* **Driver B** runs browser 2, performs the conflicting actions, and reads the event log
  aloud as things happen.
* **Swap at section 5**, so each of you has driven and narrated before the questions start.

Rehearse once end to end on the **deployed** URL, not localhost. Expect larger RTTs than
local — that is real and worth mentioning rather than hiding.
