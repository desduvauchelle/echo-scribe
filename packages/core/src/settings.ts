import { readFile, writeFile, mkdir } from 'fs/promises';
import { join } from 'path';
import { homedir } from 'os';
import { SettingsSchema, type Settings, type SettingsPatch } from '@echo-scribe/protocol';

const configDir = join(homedir(), 'EchoScribe');
const configPath = join(configDir, 'config.json');

export async function readSettings(): Promise<Settings> {
  try {
    const raw = await readFile(configPath, 'utf-8');
    const parsed: unknown = JSON.parse(raw);
    return SettingsSchema.parse(parsed);
  } catch {
    return SettingsSchema.parse({});
  }
}

export async function writeSettings(settings: Settings): Promise<void> {
  await mkdir(configDir, { recursive: true });
  await writeFile(configPath, JSON.stringify(settings, null, 2));
}

export async function applyPatch(patch: SettingsPatch): Promise<Settings> {
  const current = await readSettings();
  const merged: Settings = { ...current, ...patch };
  const validated = SettingsSchema.parse(merged);
  await writeSettings(validated);
  return validated;
}
