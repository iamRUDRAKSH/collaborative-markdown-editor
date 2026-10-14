/**
 * Control-plane transport: our own signaling protocol and our own WebRTC mesh.
 *
 * Unit II (revisited): Message-Oriented Communication, P2P Messaging, WebRTC.
 * Unit I: hybrid architecture -- centralised discovery, decentralised data.
 *
 * FA-1 let y-webrtc own every RTCPeerConnection, so there was no offer/answer code to
 * point at. Here we drive the connection lifecycle ourselves: we publish our own
 * discovery messages, create the offer, answer it, trickle ICE candidates and open the
 * data channel. The Yjs replica keeps its own separate y-webrtc mesh untouched; this is
 * a second, independent mesh carrying only coordination traffic.
 *
 * The signaling server needs no changes: y-webrtc's server is a generic topic-based
 * publish/subscribe relay, so we simply subscribe to a topic of our own.
 */

import type { Envelope, NodeId } from "./types";

/** Messages that travel over the signaling relay, before any peer connection exists. */
type SignalMessage =
  | { sig: "hello"; from: NodeId; name: string }
  | { sig: "welcome"; from: NodeId; to: NodeId; name: string }
  | { sig: "offer"; from: NodeId; to: NodeId; sdp: RTCSessionDescriptionInit }
  | { sig: "answer"; from: NodeId; to: NodeId; sdp: RTCSessionDescriptionInit }
  | { sig: "ice"; from: NodeId; to: NodeId; candidate: RTCIceCandidateInit }
  | { sig: "bye"; from: NodeId };

export type MeshEvents = {
  onPeerUp: (id: NodeId, name: string) => void;
  onPeerDown: (id: NodeId) => void;
  onMessage: (envelope: Envelope) => void;
  onLog: (text: string, level?: "info" | "warn" | "success") => void;
  onIceEvent: (id: NodeId, detail: string) => void;
  /** A peer added a media track. Null when the peer's media goes away. */
  onRemoteStream: (id: NodeId, stream: MediaStream | null) => void;
};

/** ICE configuration. STUN always; TURN only when the deployment provides credentials. */
// [DS-U2-WEBRTC-ICE] Unit II - WebRTC. STUN always, TURN relay when credentials are supplied.
function buildIceServers(): RTCIceServer[] {
  const servers: RTCIceServer[] = [
    { urls: ["stun:stun.l.google.com:19302", "stun:global.stun.twilio.com:3478"] },
  ];

  const turnUrl = import.meta.env.VITE_TURN_URL;
  const turnUser = import.meta.env.VITE_TURN_USERNAME;
  const turnCred = import.meta.env.VITE_TURN_CREDENTIAL;

  // FA-1 had STUN only, so a symmetric NAT left ICE with no candidate pair that worked.
  // A relay candidate is the fallback that makes the connection possible at all.
  if (turnUrl && turnUser && turnCred) {
    servers.push({ urls: turnUrl, username: turnUser, credential: turnCred });
  }

  return servers;
}

export function hasTurnConfigured(): boolean {
  return Boolean(
    import.meta.env.VITE_TURN_URL &&
      import.meta.env.VITE_TURN_USERNAME &&
      import.meta.env.VITE_TURN_CREDENTIAL,
  );
}

/** One peer connection in the mesh. */
type Connection = {
  id: NodeId;
  name: string;
  pc: RTCPeerConnection;
  channel: RTCDataChannel | null;
  /** Candidates that arrived before the remote description was set. */
  pendingCandidates: RTCIceCandidateInit[];
  remoteDescriptionSet: boolean;
  /**
   * Perfect-negotiation state. Adding a media track mid-session triggers renegotiation,
   * and both sides can renegotiate at once. The "polite" peer yields on a collision by
   * rolling back its own offer; the impolite one ignores the incoming offer and presses
   * on. We make the higher id polite, which pairs with the lower id being the initiator.
   */
  polite: boolean;
  makingOffer: boolean;
  ignoreOffer: boolean;
};

// [DS-U1-ARCHITECTURE] Unit I - Architectures. Hybrid: centralised discovery, decentralised data.
export class Mesh {
  private readonly selfId: NodeId;
  private readonly selfName: string;
  private readonly topic: string;
  private readonly signalingUrl: string;
  private readonly events: MeshEvents;

  private socket: WebSocket | null = null;
  private reconnectTimer: number | null = null;
  private closed = false;

  private readonly connections = new Map<NodeId, Connection>();

  /** Local camera/mic stream, if the user has started one. */
  private localStream: MediaStream | null = null;

  constructor(options: {
    selfId: NodeId;
    selfName: string;
    roomId: string;
    signalingUrl: string;
    events: MeshEvents;
  }) {
    this.selfId = options.selfId;
    this.selfName = options.selfName;
    this.topic = `ds-control-${options.roomId}`;
    this.signalingUrl = options.signalingUrl;
    this.events = options.events;
  }

  // ---------------------------------------------------------------- signaling

  connect(): void {
    if (this.closed) {
      return;
    }

    const socket = new WebSocket(this.signalingUrl);
    this.socket = socket;

    socket.addEventListener("open", () => {
      this.events.onLog(`signaling connected: ${this.signalingUrl}`, "success");
      this.publishRaw({ type: "subscribe", topics: [this.topic] });
      this.publish({ sig: "hello", from: this.selfId, name: this.selfName });
    });

    socket.addEventListener("message", (event) => {
      let parsed: { type?: string; topic?: string; data?: SignalMessage };
      try {
        parsed = JSON.parse(String(event.data));
      } catch {
        return;
      }

      if (parsed.type !== "publish" || parsed.topic !== this.topic || !parsed.data) {
        return;
      }

      // The relay echoes every published message back to the publisher too.
      if (parsed.data.from === this.selfId) {
        return;
      }

      void this.handleSignal(parsed.data);
    });

    socket.addEventListener("close", () => {
      if (this.closed) {
        return;
      }
      this.events.onLog("signaling lost -- existing peers keep working", "warn");
      this.scheduleReconnect();
    });

    socket.addEventListener("error", () => {
      this.events.onLog("signaling error", "warn");
    });
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer !== null || this.closed) {
      return;
    }
    this.reconnectTimer = window.setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, 2000);
  }

  private publishRaw(message: unknown): void {
    if (this.socket && this.socket.readyState === WebSocket.OPEN) {
      this.socket.send(JSON.stringify(message));
    }
  }

  // [DS-U2-MESSAGE-ORIENTED] Unit II - Message-Oriented Communication. Topic-based publish/subscribe.
  private publish(data: SignalMessage): void {
    this.publishRaw({ type: "publish", topic: this.topic, data });
  }

  // ------------------------------------------------- connection establishment

  /**
   * Glare avoidance. Both peers learn about each other at roughly the same moment, so
   * without a rule both would send an offer and the negotiation would collide. The peer
   * with the lower id is defined to be the initiator.
   */
  // [DS-U2-P2P] Unit II - P2P Messaging. Full mesh; lower id initiates to avoid glare.
  private isInitiatorFor(peer: NodeId): boolean {
    return this.selfId < peer;
  }

  private async handleSignal(message: SignalMessage): Promise<void> {
    switch (message.sig) {
      case "hello": {
        // Someone joined. Tell them we exist so they can learn our id.
        this.publish({
          sig: "welcome",
          from: this.selfId,
          to: message.from,
          name: this.selfName,
        });
        if (this.isInitiatorFor(message.from)) {
          await this.createOffer(message.from, message.name);
        }
        break;
      }

      case "welcome": {
        if (message.to !== this.selfId) {
          return;
        }
        if (this.isInitiatorFor(message.from)) {
          await this.createOffer(message.from, message.name);
        }
        break;
      }

      case "offer": {
        if (message.to !== this.selfId) {
          return;
        }
        await this.acceptOffer(message.from, message.sdp);
        break;
      }

      case "answer": {
        if (message.to !== this.selfId) {
          return;
        }
        const conn = this.connections.get(message.from);
        if (!conn) {
          return;
        }
        await conn.pc.setRemoteDescription(message.sdp);
        conn.remoteDescriptionSet = true;
        await this.drainCandidates(conn);
        break;
      }

      case "ice": {
        if (message.to !== this.selfId) {
          return;
        }
        const conn = this.connections.get(message.from);
        if (!conn) {
          return;
        }
        if (conn.remoteDescriptionSet) {
          await conn.pc.addIceCandidate(message.candidate).catch(() => undefined);
        } else {
          // Trickle ICE: candidates can arrive before the description they belong to.
          conn.pendingCandidates.push(message.candidate);
        }
        break;
      }

      case "bye": {
        this.dropPeer(message.from);
        break;
      }
    }
  }

  private createConnection(peer: NodeId, name: string): Connection {
    const existing = this.connections.get(peer);
    if (existing) {
      return existing;
    }

    const pc = new RTCPeerConnection({ iceServers: buildIceServers() });
    const conn: Connection = {
      id: peer,
      name,
      pc,
      channel: null,
      pendingCandidates: [],
      remoteDescriptionSet: false,
      polite: this.selfId > peer,
      makingOffer: false,
      ignoreOffer: false,
    };
    this.connections.set(peer, conn);

    // Renegotiation driver. Fires when the data channel is created and again whenever a
    // media track is added or removed, so we never hand-roll a second offer path.
    pc.addEventListener("negotiationneeded", () => {
      void this.negotiate(conn);
    });

    pc.addEventListener("track", (event) => {
      const [stream] = event.streams;
      if (stream) {
        this.events.onRemoteStream(peer, stream);
      }
    });

    pc.addEventListener("icecandidate", (event) => {
      if (event.candidate) {
        this.events.onIceEvent(peer, `${event.candidate.type ?? "?"} candidate`);
        this.publish({
          sig: "ice",
          from: this.selfId,
          to: peer,
          candidate: event.candidate.toJSON(),
        });
      }
    });

    pc.addEventListener("connectionstatechange", () => {
      this.events.onIceEvent(peer, pc.connectionState);
      if (pc.connectionState === "failed" || pc.connectionState === "closed") {
        this.dropPeer(peer);
      }
    });

    pc.addEventListener("datachannel", (event) => {
      this.attachChannel(conn, event.channel);
    });

    // A peer that joins after we started our camera still gets the tracks.
    if (this.localStream) {
      for (const track of this.localStream.getTracks()) {
        pc.addTrack(track, this.localStream);
      }
    }

    return conn;
  }

  private attachChannel(conn: Connection, channel: RTCDataChannel): void {
    conn.channel = channel;

    channel.addEventListener("open", () => {
      this.events.onLog(`data channel open to ${conn.name} (${conn.id})`, "success");
      this.events.onPeerUp(conn.id, conn.name);
    });

    channel.addEventListener("close", () => {
      this.dropPeer(conn.id);
    });

    channel.addEventListener("message", (event) => {
      try {
        const envelope = JSON.parse(String(event.data)) as Envelope;
        this.events.onMessage(envelope);
      } catch {
        // A malformed frame is dropped rather than taking the channel down.
      }
    });
  }

  /**
   * Start (or restart) negotiation towards a peer. Called from `negotiationneeded`, so it
   * covers both the initial data-channel offer and any later media renegotiation.
   */
  // [DS-U2-WEBRTC] Unit II - WebRTC. Our own offer/answer, trickle ICE, perfect negotiation.
  private async negotiate(conn: Connection): Promise<void> {
    try {
      conn.makingOffer = true;
      const offer = await conn.pc.createOffer();

      // The state can change while createOffer is awaited; setting a stale local
      // description would throw.
      if (conn.pc.signalingState !== "stable") {
        return;
      }

      await conn.pc.setLocalDescription(offer);
      this.publish({
        sig: "offer",
        from: this.selfId,
        to: conn.id,
        sdp: conn.pc.localDescription ?? offer,
      });
    } catch (error) {
      this.events.onLog(`negotiation with ${conn.id} failed: ${String(error)}`, "warn");
    } finally {
      conn.makingOffer = false;
    }
  }

  /** Open the connection as initiator: create the channel and let negotiation follow. */
  private async createOffer(peer: NodeId, name: string): Promise<void> {
    const conn = this.createConnection(peer, name);

    if (conn.channel) {
      return;
    }

    // The initiator creates the channel; the responder receives it via ondatachannel.
    // Creating it fires `negotiationneeded`, which sends the offer.
    const channel = conn.pc.createDataChannel("ds-control", { ordered: true });
    this.attachChannel(conn, channel);
  }

  private async acceptOffer(
    peer: NodeId,
    sdp: RTCSessionDescriptionInit,
  ): Promise<void> {
    const conn = this.createConnection(peer, `node-${peer}`);

    // Perfect negotiation: decide whether this offer collides with one of our own.
    const collision = conn.makingOffer || conn.pc.signalingState !== "stable";
    conn.ignoreOffer = !conn.polite && collision;

    if (conn.ignoreOffer) {
      this.events.onLog(`ignored colliding offer from ${peer} (impolite peer)`, "warn");
      return;
    }

    if (collision) {
      // Polite peer: roll our own offer back and accept theirs.
      await conn.pc.setLocalDescription({ type: "rollback" }).catch(() => undefined);
    }

    await conn.pc.setRemoteDescription(sdp);
    conn.remoteDescriptionSet = true;
    await this.drainCandidates(conn);

    const answer = await conn.pc.createAnswer();
    await conn.pc.setLocalDescription(answer);
    this.publish({
      sig: "answer",
      from: this.selfId,
      to: peer,
      sdp: conn.pc.localDescription ?? answer,
    });
  }

  private async drainCandidates(conn: Connection): Promise<void> {
    const pending = conn.pendingCandidates.splice(0);
    for (const candidate of pending) {
      await conn.pc.addIceCandidate(candidate).catch(() => undefined);
    }
  }

  private dropPeer(peer: NodeId): void {
    const conn = this.connections.get(peer);
    if (!conn) {
      return;
    }
    this.connections.delete(peer);
    try {
      conn.channel?.close();
      conn.pc.close();
    } catch {
      // Already torn down.
    }
    this.events.onRemoteStream(peer, null);
    this.events.onPeerDown(peer);
  }

  // -------------------------------------------------------------- data plane

  /** Send to one peer. Returns false when no open channel exists. */
  send(peer: NodeId, envelope: Envelope): boolean {
    const conn = this.connections.get(peer);
    if (!conn || !conn.channel || conn.channel.readyState !== "open") {
      return false;
    }
    conn.channel.send(JSON.stringify(envelope));
    return true;
  }

  /** Send to every connected peer. Returns the number of messages actually sent. */
  broadcast(envelope: Envelope): number {
    let sent = 0;
    for (const conn of this.connections.values()) {
      if (conn.channel && conn.channel.readyState === "open") {
        conn.channel.send(JSON.stringify({ ...envelope, to: conn.id }));
        sent += 1;
      }
    }
    return sent;
  }

  /** Ids of peers with an open data channel. */
  connectedPeers(): NodeId[] {
    return [...this.connections.values()]
      .filter((c) => c.channel && c.channel.readyState === "open")
      .map((c) => c.id);
  }

  peerName(peer: NodeId): string {
    return this.connections.get(peer)?.name ?? `node-${peer}`;
  }

  /** The underlying peer connections, for the WebRTC statistics panel. */
  peerConnections(): { id: NodeId; pc: RTCPeerConnection }[] {
    return [...this.connections.values()].map((c) => ({ id: c.id, pc: c.pc }));
  }

  // ------------------------------------------------------------------- media

  /**
   * Publish a local camera/microphone stream to every peer.
   *
   * Unit I: Distributed Multimedia Systems. The same peer connections that carry the
   * coordination data channel carry the media tracks, which is the point -- one
   * RTCPeerConnection multiplexes DTLS-protected data and SRTP-protected media.
   */
  addLocalStream(stream: MediaStream): void {
    this.localStream = stream;

    for (const conn of this.connections.values()) {
      for (const track of stream.getTracks()) {
        const already = conn.pc
          .getSenders()
          .some((sender) => sender.track && sender.track.id === track.id);
        if (!already) {
          // Adding a track fires `negotiationneeded`, which renegotiates the session.
          conn.pc.addTrack(track, stream);
        }
      }
    }
  }

  /** Stop publishing media and renegotiate the tracks away. */
  removeLocalStream(): void {
    for (const conn of this.connections.values()) {
      for (const sender of conn.pc.getSenders()) {
        if (sender.track) {
          conn.pc.removeTrack(sender);
        }
      }
    }

    this.localStream?.getTracks().forEach((track) => track.stop());
    this.localStream = null;
  }

  get hasLocalStream(): boolean {
    return this.localStream !== null;
  }

  destroy(): void {
    this.closed = true;
    if (this.reconnectTimer !== null) {
      window.clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.publish({ sig: "bye", from: this.selfId });
    for (const peer of [...this.connections.keys()]) {
      this.dropPeer(peer);
    }
    this.socket?.close();
    this.socket = null;
  }
}
