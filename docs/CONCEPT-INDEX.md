# Concept Index

Where each syllabus concept lives in the code. Every entry below is a real tag in the
source, so this file cannot drift out of step with it.

## How to search

List every concept in the project:

```
grep -rn "\[DS-" src deploy
```

Jump to one concept, for example Ricart-Agrawala:

```
grep -rn "DS-U3-MUTEX-RICART-AGRAWALA" src
```

In VS Code, press Cmd+Shift+F and search for `[DS-` to see them all in the sidebar.

## Unit I - Introduction

| Tag | Concept | Location |
| --- | ------- | -------- |
| `DS-U1-ARCHITECTURE` | Architectures. Hybrid: centralised discovery, decentralised data. | `src/ds/transport.ts:86` |
| `DS-U1-MIDDLEWARE` | Middleware. The layer every coordination service talks through. | `src/ds/context.ts:14` |
| `DS-U1-MULTIMEDIA` | Distributed Multimedia Systems. Camera and mic over the peer connections. | `src/ds/node.ts:415` |
| `DS-U1-SECURITY` | Design Issues, Security. Optional room key encrypts the Yjs room. | `src/ds/config.ts:94` |
| `DS-U1-VIRTUALIZATION` | Role of Virtualization. Containerised signaling tier. | `deploy/docker/Dockerfile:12` |

## Unit II - Communication

| Tag | Concept | Location |
| --- | ------- | -------- |
| `DS-U2-FAULT-TOLERANCE` | Fault tolerance. Timeout-based failure detection. | `src/ds/beacon.ts:147` |
| `DS-U2-MESSAGE-ORIENTED` | Message-Oriented Communication. Topic-based publish/subscribe. | `src/ds/transport.ts:182` |
| `DS-U2-NAMING` | Names, Identifiers, Addresses. Numeric node identifier. | `src/ds/types.ts:11` |
| `DS-U2-P2P` | P2P Messaging. Full mesh; lower id initiates to avoid glare. | `src/ds/transport.ts:194` |
| `DS-U2-RPC` | Remote Procedure Call. Stubs, deadlines, at-most-once semantics. | `src/ds/rpc.ts:65` |
| `DS-U2-STREAM-ORIENTED` | Stream-Oriented Communication. Latency, jitter, loss, bitrate. | `src/ds/qos.ts:46` |
| `DS-U2-WEBRTC` | WebRTC. Our own offer/answer, trickle ICE, perfect negotiation. | `src/ds/transport.ts:363` |
| `DS-U2-WEBRTC-ICE` | WebRTC. STUN always, TURN relay when credentials are supplied. | `src/ds/transport.ts:39` |

## Unit III - Synchronization

| Tag | Concept | Location |
| --- | ------- | -------- |
| `DS-U3-BEACON` | beacon protocol. Periodic liveness beacon, also the failure detector. | `src/ds/beacon.ts:68` |
| `DS-U3-CLOCKSYNC-BERKELEY` | Clock Synchronization. Berkeley averaging algorithm. | `src/ds/clocksync.ts:70` |
| `DS-U3-CLOCKSYNC-CRISTIAN` | Clock Synchronization. Cristian's algorithm. | `src/ds/clocksync.ts:52` |
| `DS-U3-CLOCKSYNC-ROUND` | Clock Synchronization. Coordinator drives the Berkeley round. | `src/ds/node.ts:330` |
| `DS-U3-DEADLOCK` | Knapp's classification. Edge chasing, Chandy-Misra-Haas. | `src/ds/deadlock.ts:54` |
| `DS-U3-DEADLOCK-VICTIM` | Deadlock recovery. Victim selection and abort. | `src/ds/deadlock.ts:199` |
| `DS-U3-ELECTION-BULLY` | Election Algorithms. Bully, O(n^2) messages. | `src/ds/election.ts:142` |
| `DS-U3-ELECTION-RING` | Election Algorithms. Chang-Roberts ring, O(n) messages. | `src/ds/election.ts:210` |
| `DS-U3-GLOBAL-STATE` | Global State. Chandy-Lamport snapshot, initiator side. | `src/ds/snapshot.ts:104` |
| `DS-U3-GLOBAL-STATE-MARKER` | Global State. Marker rule, records local and channel state. | `src/ds/snapshot.ts:187` |
| `DS-U3-LAMPORT` | Logical Clocks, Lamport's Algorithm. | `src/ds/clocks.ts:25` |
| `DS-U3-LAMPORT-TOTALORDER` | Lamport's Algorithm. Total order, node id breaks ties. | `src/ds/clocks.ts:144` |
| `DS-U3-MUTEX-CENTRALIZED` | Mutual Exclusion. Centralized, 3 messages per entry. | `src/ds/mutex.ts:351` |
| `DS-U3-MUTEX-FAIR` | Lodha-Kshemkalyani fairness concession rule. | `src/ds/mutex.ts:548` |
| `DS-U3-MUTEX-LAMPORT` | Mutual Exclusion. Lamport's algorithm, 3(n-1) messages. | `src/ds/mutex.ts:473` |
| `DS-U3-MUTEX-RICART-AGRAWALA` | Mutual Exclusion. Ricart-Agrawala, 2(n-1) messages. | `src/ds/mutex.ts:532` |
| `DS-U3-MUTEX-TOKEN-RING` | Mutual Exclusion. Token ring, one message per hop. | `src/ds/mutex.ts:603` |
| `DS-U3-VECTOR` | Vector Algorithm. One counter per node. | `src/ds/clocks.ts:53` |
| `DS-U3-VECTOR-COMPARE` | Vector Algorithm. Exact causality test, detects concurrency. | `src/ds/clocks.ts:98` |

## Unit IV - Emerging Paradigms

| Tag | Concept | Location |
| --- | ------- | -------- |
| `DS-U4-DFS` | Distributed File System. Chunked, content-addressed, replicated. | `src/ds/store.ts:41` |
| `DS-U4-DFS-REREPLICATE` | Distributed File System. Re-replication after a node is lost (HDFS behaviour). | `src/ds/store.ts:228` |
| `DS-U4-DISTRIBUTED-OBJECTS` | Distributed Object-Based Systems. Proxy stub for a remote object. | `src/ds/rpc.ts:149` |
| `DS-U4-KUBERNETES` | Kubernetes case study, and Unit I self study - Virtualization. | `deploy/k8s/signaling.yaml:20` |
| `DS-U4-LEDGER` | Blockchain and DLT. Hash-chained, tamper-evident snapshots. | `src/ds/snapshot.ts:353` |
| `DS-U4-SERVERLESS` | Serverless Architectures, Cloudflare Workers + Durable Objects. | `deploy/cloudflare/src/worker.ts:35` |
