import { mkdir, writeFile } from 'fs/promises';
import { join } from 'path';
import { homedir } from 'os';
import { ulid } from './ulid.ts';

const eventsBase = join(homedir(), 'EchoScribe', 'events');

/** Write a typed event to ~/EchoScribe/events/YYYY/MM/<ulid>.json */
export async function appendEvent(type: string, payload: Record<string, unknown>): Promise<string> {
  const id = ulid();
  const now = new Date();
  const year = now.getFullYear().toString();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const dir = join(eventsBase, year, month);
  await mkdir(dir, { recursive: true });
  const event = { _id: id, _type: type, _createdAt: now.toISOString(), ...payload };
  await writeFile(join(dir, `${id}.json`), JSON.stringify(event, null, 2));
  return id;
}
