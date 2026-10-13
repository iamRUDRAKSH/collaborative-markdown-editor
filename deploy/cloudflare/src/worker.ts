/**
 * Serverless signaling on Cloudflare Workers + Durable Objects.
 *
 * Unit IV: Serverless Architectures, and the Cloudflare case study.
 *
 * This replaces the Node signaling server with a function that has no server to run and
 * no instance to keep warm. It speaks the same protocol, so the client needs no change
 * beyond pointing VITE_SIGNALING_URL at the deployed Worker.
 *
 * Why a Durable Object and not just a Worker: a plain Worker is stateless and every
 * request may land on a different machine, so there is nowhere for "who is subscribed to
 * this topic" to live. A Durable Object is a single addressable instance with its own
 * storage and a guarantee that exactly one exists per id -- which gives us a serialisation
 * point without a server. Routing each room to the Durable Object named after it means
 * two peers in the same room always reach the same instance.
 *
 * The trade-off worth stating in the report: serverless removes the operational burden
 * (no process to supervise, no cold instance to pay for, automatic geographic placement)
 * but reintroduces a single logical coordination point per room, and that point is now
 * owned by a vendor. It is the same hybrid architecture as before, with the centralised
 * half rented rather than run.
 */

export interface Env {
  SIGNALING_ROOM: DurableObjectNamespace;
}

/** A client message, matching the y-webrtc signaling protocol exactly. */
type ClientMessage =
  | { type: "subscribe"; topics: string[] }
  | { type: "unsubscribe"; topics: string[] }
  | { type: "publish"; topic: string; [key: string]: unknown }
  | { type: "ping" };

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    // A plain GET is a health check; the Node server answers these too.
    if (request.headers.get("Upgrade") !== "websocket") {
      return new Response("okay", {
        status: 200,
        headers: { "content-type": "text/plain" },
      });
    }

    // Every connection for a room must reach the same Durable Object instance. The room
    // is taken from the path when present, so /room-name isolates rooms from each other;
    // otherwise one shared instance serves every topic, like the Node server does.
    const roomName = url.pathname.slice(1) || "default";
    const id = env.SIGNALING_ROOM.idFromName(roomName);
    const room = env.SIGNALING_ROOM.get(id);

    return room.fetch(request);
  },
};

/**
 * One Durable Object per room. Holds the topic -> subscriber map in memory, which is all
 * the state signaling needs: it is discovery, not storage, so nothing has to survive a
 * restart. A peer that reconnects simply re-subscribes.
 */
export class SignalingRoom {
  private readonly topics = new Map<string, Set<WebSocket>>();
  private readonly subscriptions = new Map<WebSocket, Set<string>>();

  async fetch(_request: Request): Promise<Response> {
    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];

    server.accept();
    this.subscriptions.set(server, new Set());

    server.addEventListener("message", (event: MessageEvent) => {
      let message: ClientMessage;
      try {
        message = JSON.parse(String(event.data));
      } catch {
        return;
      }
      this.handle(server, message);
    });

    const close = () => this.cleanup(server);
    server.addEventListener("close", close);
    server.addEventListener("error", close);

    return new Response(null, { status: 101, webSocket: client });
  }

  private handle(socket: WebSocket, message: ClientMessage): void {
    switch (message.type) {
      case "subscribe": {
        for (const topic of message.topics ?? []) {
          let subscribers = this.topics.get(topic);
          if (!subscribers) {
            subscribers = new Set();
            this.topics.set(topic, subscribers);
          }
          subscribers.add(socket);
          this.subscriptions.get(socket)?.add(topic);
        }
        break;
      }

      case "unsubscribe": {
        for (const topic of message.topics ?? []) {
          this.topics.get(topic)?.delete(socket);
          this.subscriptions.get(socket)?.delete(topic);
        }
        break;
      }

      case "publish": {
        const subscribers = this.topics.get(message.topic);
        if (!subscribers) {
          return;
        }
        // The Node server echoes to every subscriber including the publisher, and the
        // clients rely on filtering their own messages out. Keep that behaviour identical.
        const payload = JSON.stringify({ ...message, clients: subscribers.size });
        for (const subscriber of subscribers) {
          try {
            subscriber.send(payload);
          } catch {
            this.cleanup(subscriber);
          }
        }
        break;
      }

      case "ping": {
        socket.send(JSON.stringify({ type: "pong" }));
        break;
      }
    }
  }

  private cleanup(socket: WebSocket): void {
    const topics = this.subscriptions.get(socket);
    if (topics) {
      for (const topic of topics) {
        const subscribers = this.topics.get(topic);
        subscribers?.delete(socket);
        if (subscribers && subscribers.size === 0) {
          this.topics.delete(topic);
        }
      }
    }
    this.subscriptions.delete(socket);
    try {
      socket.close();
    } catch {
      // Already closed.
    }
  }
}
