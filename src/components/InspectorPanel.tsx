/**
 * The distributed systems inspector.
 *
 * Every algorithm in src/ds is invisible without this. The panel is the demonstration:
 * it shows the logical clocks advancing, which node is coordinator, what the lock table
 * says, how many messages a critical section actually cost against its theoretical bound,
 * the wait-for graph when a deadlock forms, and the chain of snapshot hashes.
 */

import { useRef, useState } from "react";
import type { DsNode, DsState } from "../ds/node";
import { formatVectorClock } from "../ds/clocks";
import { formatBitrate } from "../ds/qos";
import type { DocumentSection } from "../ds/sections";
import type { ElectionAlgorithm, MutexAlgorithm } from "../ds/types";

type Tab = "overview" | "mutex" | "snapshot" | "deadlock" | "storage" | "media" | "log";

const TABS: { id: Tab; label: string }[] = [
  { id: "overview", label: "Nodes & Clocks" },
  { id: "mutex", label: "Mutual Exclusion" },
  { id: "snapshot", label: "Global State" },
  { id: "deadlock", label: "Deadlock" },
  { id: "storage", label: "File Store" },
  { id: "media", label: "Media & QoS" },
  { id: "log", label: "Event Log" },
];

const MUTEX_ALGORITHMS: { id: MutexAlgorithm; label: string; cost: string }[] = [
  { id: "centralized", label: "Centralized", cost: "3 messages" },
  { id: "lamport", label: "Lamport", cost: "3(n-1)" },
  { id: "ricart-agrawala", label: "Ricart-Agrawala", cost: "2(n-1)" },
  { id: "lodha-kshemkalyani", label: "Lodha-Kshemkalyani (fair)", cost: "2(n-1)" },
  { id: "token-ring", label: "Token ring", cost: "1 per hop" },
];

type Props = {
  node: DsNode;
  state: DsState;
  sections: DocumentSection[];
};

function InspectorPanel({ node, state, sections }: Props) {
  const [tab, setTab] = useState<Tab>("overview");

  return (
    <section className="inspector">
      <header className="inspector-header">
        <div>
          <h2>Distributed Systems Inspector</h2>
          <p className="inspector-subtitle">
            node <code>{state.selfId}</code> &middot; Lamport <code>{state.lamport}</code>
            {state.isCoordinator && <span className="badge badge-coord">coordinator</span>}
            {state.electionRunning && <span className="badge badge-warn">election running</span>}
          </p>
        </div>

        <nav className="inspector-tabs">
          {TABS.map((entry) => (
            <button
              key={entry.id}
              className={tab === entry.id ? "tab tab-active" : "tab"}
              onClick={() => setTab(entry.id)}
            >
              {entry.label}
            </button>
          ))}
        </nav>
      </header>

      <div className="inspector-body">
        {tab === "overview" && <OverviewTab node={node} state={state} />}
        {tab === "mutex" && <MutexTab node={node} state={state} sections={sections} />}
        {tab === "snapshot" && <SnapshotTab node={node} state={state} />}
        {tab === "deadlock" && <DeadlockTab state={state} />}
        {tab === "storage" && <StorageTab node={node} state={state} />}
        {tab === "media" && <MediaTab node={node} state={state} />}
        {tab === "log" && <LogTab state={state} />}
      </div>
    </section>
  );
}

// ------------------------------------------------------------------ overview

function OverviewTab({ node, state }: { node: DsNode; state: DsState }) {
  return (
    <div className="tab-panel">
      <div className="stat-row">
        <Stat label="Lamport clock" value={String(state.lamport)} />
        <Stat label="Coordinator" value={state.coordinator === null ? "none" : String(state.coordinator)} />
        <Stat label="Clock correction" value={`${state.clockCorrectionMs >= 0 ? "+" : ""}${Math.round(state.clockCorrectionMs)} ms`} />
        <Stat label="Live peers" value={String(state.peers.length)} />
        <Stat label="RPC calls" value={String(state.rpcCalls)} />
        <Stat label="Beacons sent" value={String(state.beacons.sent)} />
      </div>

      <p className="mono-line">
        vector clock {formatVectorClock(state.vectorClock)}
      </p>

      <div className="control-row">
        <label>
          Election algorithm
          <select
            value={state.electionAlgorithm}
            onChange={(event) =>
              node.setElectionAlgorithm(event.target.value as ElectionAlgorithm)
            }
          >
            <option value="bully">Bully &mdash; O(n&sup2;)</option>
            <option value="ring">Ring (Chang-Roberts) &mdash; O(n)</option>
          </select>
        </label>

        <button className="action-button" onClick={() => node.forceElection()}>
          Force election
        </button>

        {state.lastElection.algorithm && (
          <span className="hint">
            last: {state.lastElection.algorithm}, {state.lastElection.messages} msgs,{" "}
            {state.lastElection.latencyMs} ms
          </span>
        )}
      </div>

      <table className="data-table">
        <thead>
          <tr>
            <th>Node</th>
            <th>Name</th>
            <th>RTT</th>
            <th>Clock offset</th>
            <th>Lamport</th>
            <th>Vector clock</th>
          </tr>
        </thead>
        <tbody>
          <tr className="self-row">
            <td>{state.selfId}</td>
            <td>{state.selfName} (this node)</td>
            <td>&mdash;</td>
            <td>&mdash;</td>
            <td>{state.lamport}</td>
            <td className="mono">{formatVectorClock(state.vectorClock)}</td>
          </tr>
          {state.peers.map((peer) => (
            <tr key={peer.id}>
              <td>{peer.id}</td>
              <td>
                {peer.name}
                {peer.id === state.coordinator && <span className="badge badge-coord">coord</span>}
              </td>
              <td>{peer.rttMs === null ? "--" : `${peer.rttMs} ms`}</td>
              <td>
                {peer.clockOffsetMs === null
                  ? "--"
                  : `${peer.clockOffsetMs >= 0 ? "+" : ""}${peer.clockOffsetMs} ms`}
              </td>
              <td>{peer.lamport}</td>
              <td className="mono">{formatVectorClock(peer.vc)}</td>
            </tr>
          ))}
        </tbody>
      </table>

      {state.peers.length === 0 && (
        <p className="hint">
          No peers yet. Open this room in a second browser to see the mesh, the clock
          offsets and the election.
        </p>
      )}
    </div>
  );
}

// --------------------------------------------------------------------- mutex

function MutexTab({
  node,
  state,
  sections,
}: {
  node: DsNode;
  state: DsState;
  sections: DocumentSection[];
}) {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const holders = new Map(state.locks.map((lock) => [lock.section, lock.holder]));

  async function acquire(sectionId: string) {
    setBusy(sectionId);
    setError(null);
    try {
      await node.acquire(sectionId);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="tab-panel">
      <div className="control-row">
        <label>
          Algorithm
          <select
            value={state.mutexAlgorithm}
            onChange={(event) => node.setMutexAlgorithm(event.target.value as MutexAlgorithm)}
          >
            {MUTEX_ALGORITHMS.map((algorithm) => (
              <option key={algorithm.id} value={algorithm.id}>
                {algorithm.label} &mdash; {algorithm.cost}
              </option>
            ))}
          </select>
        </label>
        <span className="hint">expected this round: {state.expectedCost} messages</span>
      </div>

      {error && <p className="error-line">{error}</p>}

      <h3>Sections</h3>
      <table className="data-table">
        <thead>
          <tr>
            <th>Section</th>
            <th>Held by</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {sections.map((section) => {
            const holder = holders.get(section.id);
            const mine = holder === state.selfId;
            return (
              <tr key={section.id}>
                <td>
                  <span style={{ paddingLeft: `${Math.max(0, section.level - 1) * 12}px` }}>
                    {section.title}
                  </span>
                  <code className="section-id">{section.id}</code>
                </td>
                <td>
                  {holder === undefined ? (
                    <span className="hint">free</span>
                  ) : mine ? (
                    <span className="badge badge-ok">this node</span>
                  ) : (
                    <span className="badge badge-warn">node {holder}</span>
                  )}
                </td>
                <td>
                  {mine ? (
                    <button className="action-button" onClick={() => node.release(section.id)}>
                      Release
                    </button>
                  ) : (
                    // Requesting a section someone else holds is the interesting case: it
                    // queues until they release, which is what the algorithms exist to
                    // arbitrate -- and what makes a deadlock possible.
                    <button
                      className="action-button"
                      disabled={busy === section.id}
                      onClick={() => void acquire(section.id)}
                    >
                      {busy === section.id
                        ? "Waiting..."
                        : holder === undefined
                          ? "Lock"
                          : "Request (queue)"}
                    </button>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>

      <h3>Measured cost</h3>
      {state.costs.length === 0 ? (
        <p className="hint">
          Lock and release a section to record a cycle. With one node there are no peers to
          ask, so the cost is zero until a second browser joins.
        </p>
      ) : (
        <table className="data-table">
          <thead>
            <tr>
              <th>Algorithm</th>
              <th>Peers</th>
              <th>Messages</th>
              <th>Latency</th>
            </tr>
          </thead>
          <tbody>
            {state.costs.map((cost, index) => (
              <tr key={index}>
                <td>{cost.algorithm}</td>
                <td>{cost.peers}</td>
                <td>{cost.messages}</td>
                <td>{cost.latencyMs} ms</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

// ------------------------------------------------------------------ snapshot

function SnapshotTab({ node, state }: { node: DsNode; state: DsState }) {
  return (
    <div className="tab-panel">
      <div className="control-row">
        <button className="action-button" onClick={() => node.takeSnapshot()}>
          Take snapshot
        </button>
        {state.snapshotRunning && <span className="hint">markers in flight...</span>}
      </div>

      <p className="hint">
        Chandy-Lamport records a consistent cut: each node's local state plus the messages
        that were in flight when the markers passed. FA-1's document hash was neither --
        each node hashed itself at its own moment and nothing captured the channels.
      </p>

      {state.snapshots.length === 0 ? (
        <p className="hint">No snapshots recorded yet.</p>
      ) : (
        state.snapshots.map((snapshot) => {
          const inFlight = Object.values(snapshot.channelStates).reduce(
            (sum, messages) => sum + messages.length,
            0,
          );
          return (
            <article key={snapshot.id} className="snapshot-card">
              <header>
                <strong>{snapshot.id}</strong>
                <span className={snapshot.complete ? "badge badge-ok" : "badge badge-warn"}>
                  {snapshot.complete ? "complete" : "partial"}
                </span>
              </header>
              <p className="mono-line">
                hash <code>{snapshot.hash.slice(0, 16)}</code>
                {snapshot.prevHash && (
                  <>
                    {" "}
                    &larr; prev <code>{snapshot.prevHash.slice(0, 16)}</code>
                  </>
                )}
              </p>
              <p className="hint">
                initiator {snapshot.initiator} &middot;{" "}
                {Object.keys(snapshot.localStates).length} node state(s) &middot; {inFlight}{" "}
                message(s) in flight
              </p>
              <table className="data-table compact">
                <thead>
                  <tr>
                    <th>Node</th>
                    <th>Lamport</th>
                    <th>Doc length</th>
                    <th>Locks</th>
                  </tr>
                </thead>
                <tbody>
                  {Object.keys(snapshot.localStates)
                    .map(Number)
                    .sort((a, b) => a - b)
                    .map((nodeId) => {
                      const local = snapshot.localStates[nodeId];
                      return (
                        <tr key={nodeId}>
                          <td>{nodeId}</td>
                          <td>{local.lamport}</td>
                          <td>{local.docLength}</td>
                          <td>{local.locks.length}</td>
                        </tr>
                      );
                    })}
                </tbody>
              </table>
            </article>
          );
        })
      )}
    </div>
  );
}

// ------------------------------------------------------------------ deadlock

function DeadlockTab({ state }: { state: DsState }) {
  return (
    <div className="tab-panel">
      <div className="stat-row">
        <Stat label="Deadlocks detected" value={String(state.deadlock.detections)} />
        <Stat label="Probes sent" value={String(state.deadlock.probesSent)} />
      </div>

      <p className="hint">
        Edge chasing (Chandy-Misra-Haas). A blocked node sends a probe to whoever holds what
        it wants; blocked receivers forward it onward. A probe that returns to its initiator
        proves a cycle in the wait-for graph.
      </p>

      <h3>Wait-for graph</h3>
      {state.waitForGraph.length === 0 ? (
        <p className="hint">Nothing is blocked. No edges.</p>
      ) : (
        <ul className="edge-list">
          {state.waitForGraph.map((edge, index) => (
            <li key={index}>
              <code>{edge.waiter}</code> waits on <code>{edge.holder}</code>
              <span className="hint"> for {edge.section}</span>
            </li>
          ))}
        </ul>
      )}

      {state.deadlock.lastCycle && (
        <p className="error-line">
          last cycle: {state.deadlock.lastCycle.join(" -> ")}
        </p>
      )}

      <p className="hint">
        To produce one: lock section A here and section B in another browser, then each
        request the other's section.
      </p>
    </div>
  );
}

// ------------------------------------------------------------------- storage

function StorageTab({ node, state }: { node: DsNode; state: DsState }) {
  const fileRef = useRef<HTMLInputElement | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function upload(file: File) {
    setBusy(true);
    setError(null);
    try {
      await node.uploadFile(file);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(false);
    }
  }

  async function download(fileId: string, name: string) {
    setError(null);
    try {
      const blob = await node.downloadFile(fileId);
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = name;
      document.body.appendChild(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(url);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    }
  }

  return (
    <div className="tab-panel">
      <div className="stat-row">
        <Stat label="Files" value={String(state.files.length)} />
        <Stat label="Chunks held here" value={String(state.localChunks)} />
        <Stat label="Bytes held here" value={`${(state.localBytes / 1024).toFixed(1)} KB`} />
      </div>

      <p className="hint">
        HDFS in miniature: 64 KB chunks, content-addressed by SHA-256, replicated to two
        peers, with the chunk map on the elected coordinator and re-replication driven by
        the beacon failure detector.
      </p>

      <div className="control-row">
        <input
          ref={fileRef}
          type="file"
          onChange={(event) => {
            const file = event.target.files?.[0];
            if (file) {
              void upload(file);
            }
            event.target.value = "";
          }}
        />
        {busy && <span className="hint">chunking and replicating...</span>}
      </div>

      {error && <p className="error-line">{error}</p>}

      {state.files.length > 0 && (
        <table className="data-table">
          <thead>
            <tr>
              <th>File</th>
              <th>Size</th>
              <th>Chunks</th>
              <th>Replication</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {state.files.map((file) => {
              const minReplicas = file.chunks.reduce(
                (least, chunk) => Math.min(least, chunk.replicas.length),
                Number.POSITIVE_INFINITY,
              );
              return (
                <tr key={file.id}>
                  <td>{file.name}</td>
                  <td>{(file.size / 1024).toFixed(1)} KB</td>
                  <td>{file.chunks.length}</td>
                  <td>
                    {minReplicas < 2 ? (
                      <span className="badge badge-warn">under-replicated</span>
                    ) : (
                      <span className="badge badge-ok">{minReplicas}x</span>
                    )}
                  </td>
                  <td>
                    <button
                      className="action-button"
                      onClick={() => void download(file.id, file.name)}
                    >
                      Download
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </div>
  );
}

// --------------------------------------------------------------------- media

function MediaTab({ node, state }: { node: DsNode; state: DsState }) {
  const [error, setError] = useState<string | null>(null);

  async function toggle() {
    setError(null);
    try {
      if (state.mediaOn) {
        node.stopMedia();
      } else {
        await node.startMedia();
      }
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    }
  }

  return (
    <div className="tab-panel">
      <div className="control-row">
        <button className="action-button" onClick={() => void toggle()}>
          {state.mediaOn ? "Stop camera & mic" : "Start camera & mic"}
        </button>
        {!state.turnConfigured && (
          <span className="badge badge-warn">no TURN relay configured</span>
        )}
      </div>

      {error && <p className="error-line">{error}</p>}

      <p className="hint">
        The media tracks ride the same peer connections as the coordination data channel.
        Adding a track triggers renegotiation over the offer/answer exchange, which is why
        the connection survives the camera starting mid-session.
      </p>

      <div className="video-grid">
        {state.mediaOn && (
          <VideoTile label={`${state.selfName} (you)`} stream={node.localMediaStream} muted />
        )}
        {state.remoteStreamIds.map((id) => (
          <VideoTile key={id} label={`node ${id}`} stream={node.remoteStream(id)} muted={false} />
        ))}
      </div>

      <h3>Quality of service</h3>
      {state.qos.length === 0 ? (
        <p className="hint">No peer connections to measure.</p>
      ) : (
        <table className="data-table">
          <thead>
            <tr>
              <th>Peer</th>
              <th>Candidate pair</th>
              <th>RTT</th>
              <th>Jitter</th>
              <th>Loss</th>
              <th>In</th>
              <th>Out</th>
            </tr>
          </thead>
          <tbody>
            {state.qos.map((entry) => (
              <tr key={entry.nodeId}>
                <td>{entry.nodeId}</td>
                <td className="mono">{entry.candidatePair ?? "--"}</td>
                <td>{entry.rttMs === null ? "--" : `${entry.rttMs} ms`}</td>
                <td>{entry.jitterMs === null ? "--" : `${entry.jitterMs} ms`}</td>
                <td>
                  {entry.lossRatio === null ? "--" : `${(entry.lossRatio * 100).toFixed(1)}%`}
                </td>
                <td>{formatBitrate(entry.inboundBps)}</td>
                <td>{formatBitrate(entry.outboundBps)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

function VideoTile({
  label,
  stream,
  muted,
}: {
  label: string;
  stream: MediaStream | null;
  muted: boolean;
}) {
  // The stream is attached in the ref callback, which runs after render and again
  // whenever the stream identity changes.
  return (
    <figure className="video-tile">
      <video
        ref={(element) => {
          if (element && element.srcObject !== stream) {
            element.srcObject = stream;
          }
        }}
        autoPlay
        playsInline
        muted={muted}
      />
      <figcaption>{label}</figcaption>
    </figure>
  );
}

// ------------------------------------------------------------------------ log

function LogTab({ state }: { state: DsState }) {
  return (
    <div className="tab-panel">
      <ol className="event-log">
        {state.log.map((entry) => (
          <li key={entry.seq} className={`log-${entry.level}`}>
            <span className="log-lamport">L{entry.lamport}</span>
            <span className="log-source">{entry.source}</span>
            <span className="log-text">{entry.text}</span>
          </li>
        ))}
      </ol>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="stat">
      <span className="stat-label">{label}</span>
      <span className="stat-value">{value}</span>
    </div>
  );
}

export default InspectorPanel;
