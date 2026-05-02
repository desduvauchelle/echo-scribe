// Port contract: the first line written to stdout is JSON: {"port": N}
// The native supervisor reads this line to discover the WebSocket port.
import { RpcServer } from './rpc/server.ts';
import { appendEvent } from './event-log.ts';
import { insertItem } from './db.ts';
import { ulid } from './ulid.ts';
import { readSettings, applyPatch } from './settings.ts';
import type { ItemId } from '@echo-scribe/protocol';

const bootedAt = new Date().toISOString();
const server = new RpcServer();

server.register('system.ping', async () => ({ message: 'pong' as const, bootedAt }));

server.register('voice.captured', async (params) => {
  const itemId = ulid();
  const now = new Date().toISOString();

  // Write to event log
  await appendEvent('voice.captured', {
    itemId,
    text: params.text,
    source: params.source,
    visibility: params.visibility,
    capturedAt: params.capturedAt,
  });

  // Project into SQLite
  insertItem({
    id: itemId,
    content: params.text,
    source: params.source,
    visibility: params.visibility,
    captured_at: params.capturedAt,
    created_at: now,
  });

  return { itemId: itemId as ItemId };
});

server.register('system.getSettings', async () => {
  return readSettings();
});

server.register('system.updateSettings', async (params) => {
  const updated = await applyPatch(params.patch);
  server.broadcast('settings.changed', updated);
  return updated;
});

const { actualPort } = server.start(0); // 0 = OS picks free port
console.log(JSON.stringify({ port: actualPort }));

setInterval(() => {
  server.broadcast('core.status', {
    healthy: true,
    uptimeSec: Math.floor((Date.now() - new Date(bootedAt).getTime()) / 1000),
  });
}, 2000);
