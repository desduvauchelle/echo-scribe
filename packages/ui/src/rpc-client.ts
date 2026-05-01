import { z } from 'zod';
import { Methods, Events, type MethodName, type EventName } from '@echo-scribe/protocol';

interface EchoScribeConfig {
  host: string;
  port: number;
}

type MethodResult<M extends MethodName> = z.infer<(typeof Methods)[M]['result']>;
type MethodParams<M extends MethodName> = z.infer<(typeof Methods)[M]['params']>;
type EventPayload<E extends EventName> = z.infer<(typeof Events)[E]>;

type PendingCall = {
  resolve: (value: unknown) => void;
  reject: (reason: unknown) => void;
};

const MAX_BACKOFF_MS = 30_000;

export class RpcClient {
  private ws: WebSocket | null = null;
  private pending = new Map<number, PendingCall>();
  private eventHandlers = new Map<string, Set<(payload: unknown) => void>>();
  private nextId = 1;
  private backoffMs = 1_000;
  private stopped = false;
  private config: EchoScribeConfig;

  constructor() {
    // Reads the injected config from the WKWebView host (or a dev fallback).
    const injected = (window as unknown as Record<string, unknown>)['__ECHO_SCRIBE__'];
    if (
      injected !== null &&
      typeof injected === 'object' &&
      'host' in injected &&
      'port' in injected &&
      typeof (injected as Record<string, unknown>)['host'] === 'string' &&
      typeof (injected as Record<string, unknown>)['port'] === 'number'
    ) {
      this.config = injected as EchoScribeConfig;
    } else {
      // Dev fallback — core sidecar port injected via Vite proxy or manual override.
      this.config = { host: '127.0.0.1', port: 0 };
      console.warn(
        'RpcClient: __ECHO_SCRIBE__ not found on window. Set window.__ECHO_SCRIBE__ = { host, port } before connecting.'
      );
    }
  }

  connect(): void {
    if (this.config.port === 0) return;
    this.openSocket();
  }

  private openSocket(): void {
    if (this.stopped) return;

    const url = `ws://${this.config.host}:${this.config.port}`;
    const ws = new WebSocket(url);
    this.ws = ws;

    ws.addEventListener('open', () => {
      this.backoffMs = 1_000;
    });

    ws.addEventListener('message', (event) => {
      let data: unknown;
      try {
        data = JSON.parse(event.data as string);
      } catch {
        return;
      }

      if (typeof data !== 'object' || data === null) return;
      const msg = data as Record<string, unknown>;

      // JSON-RPC response (has `id`)
      if ('id' in msg && msg['id'] !== undefined) {
        const id = msg['id'] as number;
        const pending = this.pending.get(id);
        if (!pending) return;
        this.pending.delete(id);

        if ('error' in msg) {
          pending.reject(msg['error']);
        } else {
          pending.resolve(msg['result']);
        }
        return;
      }

      // JSON-RPC notification (no `id`, has `method`)
      if ('method' in msg && typeof msg['method'] === 'string') {
        const handlers = this.eventHandlers.get(msg['method']);
        if (handlers) {
          for (const handler of handlers) {
            handler(msg['params']);
          }
        }
      }
    });

    ws.addEventListener('close', () => {
      this.ws = null;
      // Reject all pending calls — the connection is gone.
      for (const [, pending] of this.pending) {
        pending.reject(new Error('WebSocket closed'));
      }
      this.pending.clear();
      this.scheduleReconnect();
    });

    ws.addEventListener('error', () => {
      // close event fires after error, so reconnect is handled there.
    });
  }

  private scheduleReconnect(): void {
    if (this.stopped) return;
    setTimeout(() => this.openSocket(), this.backoffMs);
    this.backoffMs = Math.min(this.backoffMs * 2, MAX_BACKOFF_MS);
  }

  /** Call a registered RPC method and return a typed Promise of the result. */
  call<M extends MethodName>(method: M, params: MethodParams<M>): Promise<MethodResult<M>> {
    return new Promise((resolve, reject) => {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
        reject(new Error('WebSocket not connected'));
        return;
      }
      const id = this.nextId++;
      this.pending.set(id, {
        resolve: resolve as (value: unknown) => void,
        reject,
      });
      this.ws.send(JSON.stringify({ jsonrpc: '2.0', id, method, params }));
    });
  }

  /**
   * Subscribe to a server-pushed event.
   * Returns an unsubscribe function.
   */
  subscribe<E extends EventName>(
    event: E,
    handler: (payload: EventPayload<E>) => void
  ): () => void {
    if (!this.eventHandlers.has(event)) {
      this.eventHandlers.set(event, new Set());
    }
    const handlers = this.eventHandlers.get(event)!;
    const wrappedHandler = (payload: unknown) => handler(payload as EventPayload<E>);
    handlers.add(wrappedHandler);
    return () => handlers.delete(wrappedHandler);
  }

  disconnect(): void {
    this.stopped = true;
    this.ws?.close();
  }
}

// Singleton client shared across the app.
export const rpcClient = new RpcClient();
