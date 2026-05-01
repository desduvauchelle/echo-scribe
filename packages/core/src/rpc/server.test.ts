import { describe, test, expect, afterEach } from 'bun:test';
import { RpcServer } from './server.ts';

describe('RpcServer', () => {
  let server: RpcServer;

  afterEach(() => {
    server?.stop();
  });

  test('system.ping returns pong via real WebSocket', async () => {
    server = new RpcServer();
    const bootedAt = new Date().toISOString();
    server.register('system.ping', async () => ({ message: 'pong' as const, bootedAt }));
    const { actualPort } = server.start(0);

    const ws = new WebSocket(`ws://127.0.0.1:${actualPort}`);

    const response = await new Promise<unknown>((resolve, reject) => {
      ws.addEventListener('open', () => {
        ws.send(
          JSON.stringify({
            jsonrpc: '2.0',
            id: 1,
            method: 'system.ping',
            params: {},
          })
        );
      });
      ws.addEventListener('message', (event) => {
        resolve(JSON.parse(event.data as string));
      });
      ws.addEventListener('error', reject);
      // Safety timeout so the test doesn't hang forever
      setTimeout(() => reject(new Error('timeout')), 3000);
    });

    ws.close();

    expect(response).toMatchObject({
      jsonrpc: '2.0',
      id: 1,
      result: { message: 'pong' },
    });
  });

  test('unknown method returns -32601 error', async () => {
    server = new RpcServer();
    server.register('system.ping', async () => ({
      message: 'pong' as const,
      bootedAt: new Date().toISOString(),
    }));
    const { actualPort } = server.start(0);

    const ws = new WebSocket(`ws://127.0.0.1:${actualPort}`);

    const response = await new Promise<unknown>((resolve, reject) => {
      ws.addEventListener('open', () => {
        ws.send(
          JSON.stringify({
            jsonrpc: '2.0',
            id: 2,
            method: 'not.a.method',
            params: {},
          })
        );
      });
      ws.addEventListener('message', (event) => {
        resolve(JSON.parse(event.data as string));
      });
      ws.addEventListener('error', reject);
      setTimeout(() => reject(new Error('timeout')), 3000);
    });

    ws.close();

    expect(response).toMatchObject({
      jsonrpc: '2.0',
      id: 2,
      error: { code: -32601 },
    });
  });

  test('broadcast sends notification to all connected clients', async () => {
    server = new RpcServer();
    server.register('system.ping', async () => ({
      message: 'pong' as const,
      bootedAt: new Date().toISOString(),
    }));
    const { actualPort } = server.start(0);

    const ws1 = new WebSocket(`ws://127.0.0.1:${actualPort}`);
    const ws2 = new WebSocket(`ws://127.0.0.1:${actualPort}`);

    // Wait for both sockets to open
    await Promise.all([
      new Promise<void>((resolve) => ws1.addEventListener('open', () => resolve())),
      new Promise<void>((resolve) => ws2.addEventListener('open', () => resolve())),
    ]);

    const received1 = new Promise<unknown>((resolve) =>
      ws1.addEventListener('message', (e) => resolve(JSON.parse(e.data as string)))
    );
    const received2 = new Promise<unknown>((resolve) =>
      ws2.addEventListener('message', (e) => resolve(JSON.parse(e.data as string)))
    );

    server.broadcast('core.status', { healthy: true, uptimeSec: 42 });

    const [msg1, msg2] = await Promise.all([received1, received2]);

    ws1.close();
    ws2.close();

    expect(msg1).toMatchObject({ jsonrpc: '2.0', method: 'core.status', params: { healthy: true, uptimeSec: 42 } });
    expect(msg2).toMatchObject({ jsonrpc: '2.0', method: 'core.status', params: { healthy: true, uptimeSec: 42 } });
  });
});
