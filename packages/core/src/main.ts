// Port contract: the first line written to stdout is JSON: {"port": N}
// The native supervisor reads this line to discover the WebSocket port.
import { RpcServer } from './rpc/server.ts';

const bootedAt = new Date().toISOString();
const server = new RpcServer();

server.register('system.ping', async () => ({ message: 'pong' as const, bootedAt }));

const { actualPort } = server.start(0); // 0 = OS picks free port
console.log(JSON.stringify({ port: actualPort }));

setInterval(() => {
  server.broadcast('core.status', {
    healthy: true,
    uptimeSec: Math.floor((Date.now() - new Date(bootedAt).getTime()) / 1000),
  });
}, 2000);
