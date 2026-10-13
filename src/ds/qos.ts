/**
 * Quality-of-service measurement for the peer connections.
 *
 * Unit II: Stream-Oriented Communication -- the topic FA-1 had in shape but not in
 * substance. A data channel was carrying a continuous stream of updates, but nothing
 * measured latency, jitter, loss or throughput, so there was no QoS story to tell.
 *
 * These numbers come from the standard WebRTC statistics API, and they are the same
 * quantities the lecture names:
 *
 *   latency  -- currentRoundTripTime on the selected candidate pair
 *   jitter   -- variation in inter-arrival time, reported per inbound stream
 *   loss     -- packetsLost against packetsReceived
 *   rate     -- bytes per second, computed between two samples
 *
 * Jitter and loss only appear once media is flowing: SCTP data channels are reliable and
 * ordered, so they report no loss by construction. That contrast is worth showing -- it is
 * the difference between a reliable stream and a real-time one.
 */

import type { NodeId } from "./types";

export type PeerQos = {
  nodeId: NodeId;
  /** Round-trip time on the selected ICE candidate pair, in ms. */
  rttMs: number | null;
  /** Jitter on the inbound media stream, in ms. */
  jitterMs: number | null;
  /** Fraction of inbound packets lost, 0 to 1. */
  lossRatio: number | null;
  /** Inbound throughput in bits per second. */
  inboundBps: number | null;
  /** Outbound throughput in bits per second. */
  outboundBps: number | null;
  /** The ICE candidate types actually in use, e.g. "host / srflx". */
  candidatePair: string | null;
  /** Bytes still queued on the data channel, the backpressure signal. */
  bufferedAmount: number;
};

type Sample = { at: number; bytesReceived: number; bytesSent: number };

const previous = new Map<NodeId, Sample>();

/** Read one QoS sample per peer connection. */
export async function collectQos(
  connections: { id: NodeId; pc: RTCPeerConnection }[],
): Promise<PeerQos[]> {
  const results: PeerQos[] = [];

  for (const { id, pc } of connections) {
    const entry: PeerQos = {
      nodeId: id,
      rttMs: null,
      jitterMs: null,
      lossRatio: null,
      inboundBps: null,
      outboundBps: null,
      candidatePair: null,
      bufferedAmount: 0,
    };

    let report: RTCStatsReport;
    try {
      report = await pc.getStats();
    } catch {
      results.push(entry);
      continue;
    }

    const candidates = new Map<string, { candidateType?: string }>();
    let bytesReceived = 0;
    let bytesSent = 0;
    let packetsLost = 0;
    let packetsReceived = 0;

    report.forEach((stat) => {
      const record = stat as Record<string, unknown>;

      if (record.type === "local-candidate" || record.type === "remote-candidate") {
        candidates.set(String(record.id), {
          candidateType: record.candidateType as string | undefined,
        });
      }

      if (record.type === "candidate-pair" && record.state === "succeeded" && record.nominated) {
        if (typeof record.currentRoundTripTime === "number") {
          entry.rttMs = Math.round(record.currentRoundTripTime * 1000 * 10) / 10;
        }
        const local = candidates.get(String(record.localCandidateId));
        const remote = candidates.get(String(record.remoteCandidateId));
        if (local || remote) {
          entry.candidatePair = `${local?.candidateType ?? "?"} / ${remote?.candidateType ?? "?"}`;
        }
      }

      if (record.type === "inbound-rtp") {
        if (typeof record.jitter === "number") {
          entry.jitterMs = Math.round(record.jitter * 1000 * 10) / 10;
        }
        if (typeof record.packetsLost === "number") {
          packetsLost += record.packetsLost;
        }
        if (typeof record.packetsReceived === "number") {
          packetsReceived += record.packetsReceived;
        }
        if (typeof record.bytesReceived === "number") {
          bytesReceived += record.bytesReceived;
        }
      }

      if (record.type === "outbound-rtp" && typeof record.bytesSent === "number") {
        bytesSent += record.bytesSent;
      }

      // Data-channel traffic is reported on the transport, not as RTP.
      if (record.type === "transport") {
        if (typeof record.bytesReceived === "number") {
          bytesReceived += record.bytesReceived;
        }
        if (typeof record.bytesSent === "number") {
          bytesSent += record.bytesSent;
        }
      }
    });

    const total = packetsLost + packetsReceived;
    if (total > 0) {
      entry.lossRatio = packetsLost / total;
    }

    const now = performance.now();
    const last = previous.get(id);

    if (last) {
      const seconds = (now - last.at) / 1000;
      if (seconds > 0) {
        entry.inboundBps = Math.max(0, ((bytesReceived - last.bytesReceived) * 8) / seconds);
        entry.outboundBps = Math.max(0, ((bytesSent - last.bytesSent) * 8) / seconds);
      }
    }

    previous.set(id, { at: now, bytesReceived, bytesSent });

    results.push(entry);
  }

  return results;
}

/** Drop cached samples for a peer that has gone away. */
export function forgetQos(id: NodeId): void {
  previous.delete(id);
}

export function formatBitrate(bps: number | null): string {
  if (bps === null) {
    return "--";
  }
  if (bps >= 1_000_000) {
    return `${(bps / 1_000_000).toFixed(1)} Mbps`;
  }
  if (bps >= 1000) {
    return `${(bps / 1000).toFixed(0)} kbps`;
  }
  return `${Math.round(bps)} bps`;
}
