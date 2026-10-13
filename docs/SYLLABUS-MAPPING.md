# Four Units, One Codebase

Every concept named in the Distributed Systems syllabus (Units I-IV, Final Year B.Tech
Regulations 2023), traced to the file that implements it.

**29 in code · 6 partial · 3 report only**, across 38 syllabus lines.

| Unit | In code | Partial | Report only |
| ---- | ------- | ------- | ----------- |
| I — Introduction | 7 | 3 | — |
| II — Communication | 7 | 1 | — |
| III — Synchronization | 9 | 1 | — |
| IV — Emerging Paradigms | 6 | 1 | 3 |

Every anchor below was checked against the source, not recalled.

## How to read this

* **In code** — running code you can point at and demonstrate. The inspector panel shows it working.
* **Partial** — genuinely implemented, but not the whole concept. The gap is stated in the row.
* **Report only** — written up, not built. Say so plainly rather than being caught claiming it.

### The one-sentence thesis

FA-1 built a system that *deliberately avoids coordination* — a CRDT merges anything but
guarantees nothing. FA-2 added exclusive section locks, a guarantee a CRDT cannot express,
and every Unit III algorithm follows from needing it.

That matters in the viva because no algorithm here is decorative. Asked "why did you need an
election?", the answer is: because centralized mutual exclusion needs a coordinator, and the
coordinator can crash.

## Unit I — Introduction to Distributed Systems

*7 in code, 3 partial*

| Concept | What implements it | Anchor | Status |
| ------- | ------------------ | ------ | ------ |
| Definition | Each browser tab is an autonomous node with its own replica, OS and protocol stack, bound by middleware over a network | `ds/node.ts` → `DsNode` | In code |
| Goals | Resource sharing, reliability through replication and transparency are met. **Scalability is not** — the mesh is O(n²) and breaks down past roughly six peers | `ds/transport.ts` → `Mesh` | Partial |
| Types of Distributed Systems | A pervasive / collaborative system. The chunk store adds a distributed-information flavour, but no computing cluster or grid | `ds/store.ts` | Partial |
| Architectures | Hybrid: centralised discovery, decentralised data. Two independent meshes share one relay on separate topics | `ds/transport.ts:85` | In code |
| Design Issues | Transparency (access, concurrency, replication, location) and **security** via an optional room key. Migration and relocation transparency remain absent | `ds/config.ts:52` → `readRoomKey` | Partial |
| Middleware | Two layers: Yjs for convergence, and our own coordination middleware running identically on every node | `ds/context.ts` → `ServiceContext` | In code |
| Overview of Distributed Systems | Architecture diagram, concept tables and demo script | `README.md` | In code |
| Distributed multimedia systems | Camera and microphone published over the same peer connections as the data channel; adding a track renegotiates the session | `ds/node.ts` → `startMedia`, `ds/transport.ts` → `addLocalStream` | In code |
| *Self study:* Model of distributed computations | Events, sends and receives ordered by Lamport and vector clocks; consistent cuts recorded by snapshot | `ds/clocks.ts:25`, `:52`, `ds/snapshot.ts:104` | In code |
| *Self study:* Role of Virtualization | Signaling tier containerised and deployed to a cluster, so it runs identically on a laptop and a node | `deploy/docker/Dockerfile`, `deploy/k8s/signaling.yaml` | In code |

## Unit II — Communication

*7 in code, 1 partial*

The unit FA-1 was weakest on. RPC did not exist, stream-oriented communication had no QoS,
and the library owned every `RTCPeerConnection`. All three are now ours.

| Concept | What implements it | Anchor | Status |
| ------- | ------------------ | ------ | ------ |
| Fundamentals | Transient asynchronous messaging plus synchronous request/response, with explicit marshalling into an envelope. **Persistent communication is still absent** — a message to an offline peer is lost, not queued | `ds/types.ts:20` → `Envelope` | Partial |
| Remote Procedure Call | Stub via Proxy so a remote call reads as a local one; request ids, deadlines, and **at-most-once** semantics by deduplicating on the server | `ds/rpc.ts:65` → `RpcEndpoint`, `stub()`, `accept()` | In code |
| Message-Oriented Communication | Topic-based publish/subscribe for discovery, plus our own envelope protocol on the data channel. No durable queue or dead-letter handling | `ds/transport.ts` → `publish()` | In code |
| Stream-Oriented Communication | Continuous media plus measured QoS: latency, jitter, packet loss, bitrate and the selected candidate pair | `ds/qos.ts:46` → `collectQos` | In code |
| P2P Messaging | Full mesh where every peer is client and server; glare avoided by making the lower id the initiator | `ds/transport.ts` → `isInitiatorFor` | In code |
| WebRTC | We create the offer, answer it, trickle ICE and open the channel ourselves, with perfect negotiation for mid-session renegotiation and an optional TURN relay | `ds/transport.ts` → `negotiate`, `acceptOffer`, `buildIceServers` | In code |
| *Self study:* Names, Identifiers, Addresses | Room URL is the name; room UUID and numeric `NodeId` are identifiers; the ICE candidate pair is the address. Chunks add content addressing, where the name *is* the hash | `ds/types.ts:11` → `NodeId`, `ds/store.ts` → `sha256` | In code |
| *Self study:* Fault tolerance | Timeout-based failure detection, local checkpoint and recovery, replication with repair, and coordinator failover | `ds/beacon.ts:68`, `ds/store.ts` → `onPeerDown` | In code |

## Unit III — Synchronization

*9 in code, 1 partial*

The core of FA-2. Every named algorithm is implemented, and where the syllabus names a
category rather than one algorithm we built several so the costs can be compared live.

| Concept | What implements it | Anchor | Status |
| ------- | ------------------ | ------ | ------ |
| Clock Synchronization | **Cristian's** from the beacon round trip, and **Berkeley** run by the coordinator, which averages the group rather than imposing one clock | `ds/clocksync.ts:52` → `cristian`, `:69` → `berkeley`, `ds/node.ts:330` → `runBerkeleyRound` | In code |
| Logical Clocks | Lamport counter stamped on every outgoing message and merged on every receive | `ds/clocks.ts:25` → `LamportClock` | In code |
| Lamport's Algorithm | Both readings covered: the clock rules and total order with node-id tiebreak, *and* Lamport's mutual-exclusion algorithm with its request queue | `ds/clocks.ts:141` → `compareLamport`, `ds/mutex.ts:472` → `requestLamport` | In code |
| Global State | Chandy–Lamport with marker propagation on every outgoing channel and recorded channel contents. Replaces FA-1's document hash, which was not a consistent cut | `ds/snapshot.ts:104` → `initiate`, `onMarker` | In code |
| Vector Algorithm | Vector clocks characterising causality exactly, so genuine concurrency is detected rather than guessed | `ds/clocks.ts:52` → `VectorClock`, `:96` → `compareVectorClocks` | In code |
| Election Algorithms | **Bully** (O(n²), one round trip) and **Chang–Roberts ring** (O(n), latency proportional to ring length), switchable at runtime with measured message counts | `ds/election.ts:142` → `startBully`, `:209` → `startRing` | In code |
| Mutual Exclusion Algorithms | Five: centralized (3 msgs), Lamport (3(n−1)), Ricart–Agrawala (2(n−1)), token ring (1 per hop), and a fairness variant. Measured cost shown beside the theoretical bound | `ds/mutex.ts:351`, `:472`, `:530`, `:599` | In code |
| beacon protocol | Periodic beacon carrying clocks and lock state; doubles as the failure detector and supplies the timestamps Cristian's needs. *See caveat below* | `ds/beacon.ts:68` → `BeaconService` | In code |
| *Self study:* Lodha–Kshemkalyani fair mutual exclusion | Ricart–Agrawala with a strict FIFO deferred queue and a concession rule that bounds waiting. **The fairness property is reproduced; the published message-reduction scheme is not** | `ds/mutex.ts` → `releaseRicartAgrawala` | Partial |
| *Self study:* Knapp's classification of deadlock detection | Edge-chasing (Chandy–Misra–Haas) implemented; the other three classes — path-pushing, diffusion computation, global-state detection — classified in the comments | `ds/deadlock.ts:54` → `DeadlockService`, `:198` → `onDeadlock` | In code |

### Caveat: "beacon protocol"

This term is not standard Kshemkalyani terminology, and we could not confirm what the course
means by it. We implemented it as a periodic liveness beacon — the standard reading, and the
one that makes the failure detector and the election work.

If the examiner means something else, say you implemented it as a heartbeat beacon and ask.
The mechanism is about eighty lines and the shape would not change much. Pretending to a
definition you do not have is the worse answer.

## Unit IV — Emerging Distributed Paradigms

*6 in code, 1 partial, 3 report only*

Two of the five case studies are actually deployed rather than described.

| Concept | What implements it | Anchor | Status |
| ------- | ------------------ | ------ | ------ |
| Distributed Object-Based Systems | A remote object reached through a generated stub; every service publishes methods on it, and the coordinator's lock manager is the canonical remote object | `ds/rpc.ts:65` → `stub()`, `ds/store.ts` → `registerHandlers` | In code |
| Distributed Web-Based Systems | The product is a browser-native distributed system over standard web protocols. **No REST gateway, caching tier or content replication**, which is what the topic usually means | `src/App.tsx`, `src/pages/` | Partial |
| Distributed file system | 64 KB chunks, content-addressed by SHA-256, replication factor 2, chunk map on the coordinator, re-replication driven by the failure detector | `ds/store.ts:41` → `ChunkStore`, `:30`, `:33` | In code |
| Serverless Architectures | Signaling as a Worker with a Durable Object per room — a serialisation point with no server to run. Same protocol, so the client only changes one env var | `deploy/cloudflare/src/worker.ts` → `SignalingRoom` | In code |
| Case study: Cloudflare | Not described — used. Workers plus Durable Objects are the serverless deployment above | `deploy/cloudflare/wrangler.toml` | In code |
| Case study: Kubernetes | Deployment with replicas, liveness and readiness probes, a Service, and session affinity. The in-memory relay limitation is documented in the manifest | `deploy/k8s/signaling.yaml` | In code |
| Case study: Apache Hadoop | Point-by-point design comparison between HDFS and our chunk store: block size, NameNode vs coordinator, heartbeats vs beacons, re-replication | `ds/store.ts` — header comment | Report only |
| Case study: AWS | Written comparison only. Nothing deployed on AWS | *to write* | Report only |
| Case study: Megaport | Written comparison only. Nothing deployed | *to write* | Report only |
| *Self study:* Blockchain and DLT, trade-offs | Each snapshot is hashed and chained to its predecessor, giving a tamper-evident global history — integrity of the record without paying for consensus, the opposite of a blockchain's choice | `ds/snapshot.ts` → `hashSnapshot` | In code |

## What FA-2 changed

| FA-1 state | FA-2 state | Anchor |
| ---------- | ---------- | ------ |
| No RPC anywhere | Stubs, deadlines, at-most-once; every service uses it | `ds/rpc.ts` |
| y-webrtc owned every peer connection | We drive offer/answer, ICE and the data channel ourselves | `ds/transport.ts` |
| Document hash called a "global state" | Real Chandy–Lamport consistent cut, old hash kept for contrast | `ds/snapshot.ts` |
| No multimedia | Camera and mic over the same peer connections | `ds/node.ts` → `startMedia` |
| Streams with no QoS | Latency, jitter, loss and bitrate sampled every 2 s | `ds/qos.ts` |
| STUN only, no relay | TURN added when credentials are configured | `ds/transport.ts` → `buildIceServers` |
| No security at all | Optional room key encrypts the room; key lives in the URL fragment so the relay never sees it | `ds/config.ts:52` |
| No virtualization | Container image and cluster manifests | `deploy/` |
| Username shared across tabs, rebuilt the provider | Per-tab identity, so two tabs are genuinely two nodes | `ds/config.ts` → `readUserName` |

## Absent by design

Not in the syllabus, but an examiner may well ask. Having the reason ready is stronger than
being surprised.

* **Consensus, voting and quorum, distributed commit.** A CRDT converges *without* agreement:
  concurrent insertions are ordered deterministically by origin reference with the client id
  breaking ties, so every replica computes the same result independently. The price is that no
  global invariant can be enforced — you cannot guarantee the document has exactly one title,
  because that needs the coordination you gave up. The section locks buy a narrow slice back.
* **Termination detection and distributed garbage collection.** No global termination condition
  exists in a document that is never finished. Yjs collects tombstones locally, but that is
  memory hygiene, not the distributed algorithm.
* **Persistent / queued messaging.** Everything is transient. A message to an offline peer is
  lost rather than stored and forwarded, which is the main thing separating this from a
  message-oriented middleware like Kafka.

## Evidence from running it

Observed with two live peers, not inferred from the code.

**Election failover**

```
peer node-645442 disconnected
coordinator node-645442 is down -- starting election
bully: coordinator is this node (0 msgs, 0ms)
released methods stranded by failed node 645442
```

**Deadlock detected and broken**

```
DEADLOCK detected, cycle: 155588 -> 645442 -> 155588
aborting own request for methods to break the cycle
```

**Consistent cut with a message in flight**

```
snap-155588-2  COMPLETE
hash 8ba385160fc6a78b <- prev d46c775f273a8a62
2 node state(s), 1 message(s) in flight
```

**Mutual exclusion refusing an edit.** With "Introduction" locked by the other peer, typing
into it left the character count unchanged at 105, while an edit to the unlocked "Methods"
section propagated and both peers moved to 122. The lock is enforced, and the filter is
selective.

**Clock skew is real.** Measured RTT 4 ms and clock offset −1 ms between peers, with Berkeley
corrections of +2 to +7 ms applied. This is the concrete answer to "why not just use
timestamps?" — the offset is never zero.

## Limitations to state before you are asked

* **Lock enforcement is cooperative.** The editor refuses local edits into a locked section,
  but nothing in a peer-to-peer CRDT can stop a modified client from writing anyway. It
  enforces among cooperating nodes, not against an adversarial one.
* **The failure detector is unreliable in the formal sense.** A slow network is
  indistinguishable from a crashed peer, so a live coordinator can be wrongly replaced. The
  election tolerates this — it simply loses an election it would have won.
* **Token-ring loses its token** when the holder crashes. The lowest live id regenerates it
  after a timeout, which can briefly admit two holders.
* **Durability is bounded by open tabs.** Every replica lives in a browser. Close the last two
  holding a chunk and it is gone.
* **The mesh is still O(n²)** and still unsuitable for large groups. The route past it is an
  SFU, a superpeer tier, or a structured overlay.
* **Two Kubernetes replicas do not share topics.** The relay keeps subscribers in memory, so
  session affinity is doing work a shared backplane should. This is the argument for the
  Durable Object version.
