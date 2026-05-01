import { z } from 'zod';
import { Methods, Events, type MethodName, type EventName } from '@echo-scribe/protocol';

type Handler<M extends MethodName> = (
  params: z.infer<(typeof Methods)[M]['params']>
) => Promise<z.infer<(typeof Methods)[M]['result']>>;

interface JsonRpcRequest {
  jsonrpc: '2.0';
  id: string | number | null;
  method: string;
  params: unknown;
}

interface JsonRpcSuccess {
  jsonrpc: '2.0';
  id: string | number | null;
  result: unknown;
}

interface JsonRpcError {
  jsonrpc: '2.0';
  id: string | number | null;
  error: { code: number; message: string };
}

type JsonRpcResponse = JsonRpcSuccess | JsonRpcError;

const RequestShape = z.object({
  jsonrpc: z.literal('2.0'),
  id: z.union([z.string(), z.number(), z.null()]),
  method: z.string(),
  params: z.unknown().optional(),
});

export class RpcServer {
  // biome-ignore lint/suspicious/noExplicitAny: handler map needs any to hold heterogeneous generic handlers
  private handlers = new Map<MethodName, Handler<any>>();
  private clients = new Set<import('bun').ServerWebSocket<unknown>>();
  private bunServer: ReturnType<typeof Bun.serve> | null = null;

  register<M extends MethodName>(method: M, handler: Handler<M>): void {
    this.handlers.set(method, handler);
  }

  start(port: number): { actualPort: number } {
    const self = this;

    this.bunServer = Bun.serve({
      port,
      hostname: '127.0.0.1',
      fetch(req, server) {
        if (server.upgrade(req)) return undefined;
        return new Response('not found', { status: 404 });
      },
      websocket: {
        open(ws) {
          self.clients.add(ws);
        },
        close(ws) {
          self.clients.delete(ws);
        },
        async message(ws, data) {
          const raw = typeof data === 'string' ? data : data.toString();
          let parsed: unknown;
          try {
            parsed = JSON.parse(raw);
          } catch {
            ws.send(
              JSON.stringify({
                jsonrpc: '2.0',
                id: null,
                error: { code: -32700, message: 'Parse error' },
              } satisfies JsonRpcError)
            );
            return;
          }

          const requestResult = RequestShape.safeParse(parsed);
          if (!requestResult.success) {
            ws.send(
              JSON.stringify({
                jsonrpc: '2.0',
                id: null,
                error: { code: -32600, message: 'Invalid Request' },
              } satisfies JsonRpcError)
            );
            return;
          }

          const request = requestResult.data as JsonRpcRequest;
          const { id, method } = request;

          if (!self.handlers.has(method as MethodName)) {
            ws.send(
              JSON.stringify({
                jsonrpc: '2.0',
                id,
                error: { code: -32601, message: `Method not found: ${method}` },
              } satisfies JsonRpcError)
            );
            return;
          }

          const methodKey = method as MethodName;
          const schema = Methods[methodKey].params;
          const paramsResult = schema.safeParse(request.params ?? {});
          if (!paramsResult.success) {
            ws.send(
              JSON.stringify({
                jsonrpc: '2.0',
                id,
                error: { code: -32602, message: 'Invalid params' },
              } satisfies JsonRpcError)
            );
            return;
          }

          try {
            const handler = self.handlers.get(methodKey)!;
            const result = await handler(paramsResult.data);
            ws.send(
              JSON.stringify({
                jsonrpc: '2.0',
                id,
                result,
              } satisfies JsonRpcSuccess)
            );
          } catch (err) {
            const message = err instanceof Error ? err.message : 'Internal error';
            ws.send(
              JSON.stringify({
                jsonrpc: '2.0',
                id,
                error: { code: -32603, message },
              } satisfies JsonRpcError)
            );
          }
        },
      },
    });

    return { actualPort: this.bunServer.port };
  }

  /** Send a JSON-RPC notification to all connected clients. */
  broadcast<E extends EventName>(event: E, payload: z.infer<(typeof Events)[E]>): void {
    const message = JSON.stringify({
      jsonrpc: '2.0',
      method: event,
      params: payload,
    });
    for (const client of this.clients) {
      client.send(message);
    }
  }

  stop(): void {
    this.bunServer?.stop();
  }
}
