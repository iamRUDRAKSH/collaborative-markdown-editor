/**
 * Remote Procedure Call over the data channel.
 *
 * Unit II: Remote Procedure Call -- the topic FA-1 had no answer for.
 * Unit IV: Distributed Object-Based Systems -- a remote object reached through a stub.
 *
 * The lecture's RPC lifecycle, implemented here end to end:
 *   1. Client calls a generated stub.          -> createStub() returns a Proxy
 *   2. Stub serialises arguments.              -> JSON encoding into the envelope body
 *   3. Transport sends the request.            -> Mesh.send over RTCDataChannel
 *   4. Server decodes and dispatches.          -> handleRequest()
 *   5. Server executes and serialises a result.
 *   6. Response returns; stub decodes it.
 *
 * Failure semantics are deliberately **at-most-once**: a call that times out is never
 * retried automatically, and the server deduplicates by request id so a replayed frame
 * cannot execute a method twice. We chose at-most-once because the operations the
 * coordinator exposes (granting a lock, taking a snapshot) are not idempotent -- running
 * one twice would be worse than not running it at all.
 */

import type { Envelope, NodeId } from "./types";

export const RPC_REQUEST = "rpc-request";
export const RPC_RESPONSE = "rpc-response";

type RpcRequestBody = {
  id: string;
  method: string;
  params: unknown[];
};

type RpcResponseBody = {
  id: string;
  ok: boolean;
  result?: unknown;
  error?: string;
};

export class RpcTimeoutError extends Error {
  constructor(method: string, peer: NodeId, timeoutMs: number) {
    super(`RPC ${method} to node ${peer} timed out after ${timeoutMs}ms`);
    this.name = "RpcTimeoutError";
  }
}

type Pending = {
  method: string;
  resolve: (value: unknown) => void;
  reject: (reason: Error) => void;
  timer: number;
  startedAt: number;
};

export type RpcHandler = (params: unknown[], from: NodeId) => unknown | Promise<unknown>;

export type RpcOptions = {
  /** Send one envelope to one peer. Returns false if the peer is unreachable. */
  send: (peer: NodeId, kind: string, body: unknown) => boolean;
  onLog: (text: string, level?: "info" | "warn" | "success") => void;
  /** Default deadline for a call, in ms. */
  defaultTimeoutMs?: number;
};

// [DS-U2-RPC] Unit II - Remote Procedure Call. Stubs, deadlines, at-most-once semantics.
export class RpcEndpoint {
  private readonly handlers = new Map<string, RpcHandler>();
  private readonly pending = new Map<string, Pending>();

  /**
   * Responses we have already produced, keyed by request id. This is what makes the
   * semantics at-most-once rather than at-least-once: a duplicate request returns the
   * original response instead of running the method again.
   */
  private readonly completed = new Map<string, RpcResponseBody>();

  private readonly send: RpcOptions["send"];
  private readonly onLog: RpcOptions["onLog"];
  private readonly defaultTimeoutMs: number;

  private sequence = 0;
  private callCount = 0;

  constructor(options: RpcOptions) {
    this.send = options.send;
    this.onLog = options.onLog;
    this.defaultTimeoutMs = options.defaultTimeoutMs ?? 5000;
  }

  /** Publish a method on this node's remote object. */
  register(method: string, handler: RpcHandler): void {
    this.handlers.set(method, handler);
  }

  get methods(): string[] {
    return [...this.handlers.keys()].sort();
  }

  get totalCalls(): number {
    return this.callCount;
  }

  /** Invoke a method on a remote node. */
  call<T = unknown>(
    peer: NodeId,
    method: string,
    params: unknown[] = [],
    timeoutMs = this.defaultTimeoutMs,
  ): Promise<T> {
    this.sequence += 1;
    this.callCount += 1;
    const id = `${method}-${this.sequence}-${Math.random().toString(36).slice(2, 8)}`;

    return new Promise<T>((resolve, reject) => {
      const delivered = this.send(peer, RPC_REQUEST, {
        id,
        method,
        params,
      } satisfies RpcRequestBody);

      if (!delivered) {
        reject(new Error(`no open channel to node ${peer}`));
        return;
      }

      const timer = window.setTimeout(() => {
        this.pending.delete(id);
        this.onLog(`rpc ${method} -> ${peer} timed out`, "warn");
        reject(new RpcTimeoutError(method, peer, timeoutMs));
      }, timeoutMs);

      this.pending.set(id, {
        method,
        resolve: resolve as (value: unknown) => void,
        reject,
        timer,
        startedAt: performance.now(),
      });
    });
  }

  /**
   * A stub that makes a remote object look like a local one.
   *
   * `const remote = rpc.stub<Coordinator>(coordinatorId); await remote.acquire("intro")`
   * reads like a local method call, which is exactly the illusion RPC exists to create --
   * and exactly the illusion that hides partial failure, so every call still has a deadline.
   */
  // [DS-U4-DISTRIBUTED-OBJECTS] Unit IV - Distributed Object-Based Systems. Proxy stub for a remote object.
  stub<T extends object>(peer: NodeId, timeoutMs = this.defaultTimeoutMs): T {
    return new Proxy({} as T, {
      get: (_target, property) => {
        const method = String(property);
        return (...params: unknown[]) => this.call(peer, method, params, timeoutMs);
      },
    });
  }

  /** Feed an incoming envelope to the endpoint. Returns true if it was RPC traffic. */
  accept(envelope: Envelope): boolean {
    if (envelope.kind === RPC_REQUEST) {
      void this.handleRequest(envelope.from, envelope.body as RpcRequestBody);
      return true;
    }

    if (envelope.kind === RPC_RESPONSE) {
      this.handleResponse(envelope.body as RpcResponseBody);
      return true;
    }

    return false;
  }

  private async handleRequest(from: NodeId, body: RpcRequestBody): Promise<void> {
    const cached = this.completed.get(body.id);
    if (cached) {
      // Duplicate delivery. Replay the original response; do not execute twice.
      this.send(from, RPC_RESPONSE, cached);
      return;
    }

    const handler = this.handlers.get(body.method);
    let response: RpcResponseBody;

    if (!handler) {
      response = { id: body.id, ok: false, error: `no such method: ${body.method}` };
    } else {
      try {
        const result = await handler(body.params ?? [], from);
        response = { id: body.id, ok: true, result };
      } catch (error) {
        response = {
          id: body.id,
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        };
      }
    }

    this.completed.set(body.id, response);
    // Keep the dedup window bounded; ids are unique per call so this only bounds memory.
    if (this.completed.size > 500) {
      const oldest = this.completed.keys().next().value;
      if (oldest !== undefined) {
        this.completed.delete(oldest);
      }
    }

    this.send(from, RPC_RESPONSE, response);
  }

  private handleResponse(body: RpcResponseBody): void {
    const pending = this.pending.get(body.id);
    if (!pending) {
      // Arrived after the deadline fired. Dropped, because the caller already gave up.
      return;
    }

    this.pending.delete(body.id);
    window.clearTimeout(pending.timer);

    if (body.ok) {
      pending.resolve(body.result);
    } else {
      pending.reject(new Error(body.error ?? "remote error"));
    }
  }

  destroy(): void {
    for (const pending of this.pending.values()) {
      window.clearTimeout(pending.timer);
      pending.reject(new Error("endpoint destroyed"));
    }
    this.pending.clear();
    this.completed.clear();
    this.handlers.clear();
  }
}
