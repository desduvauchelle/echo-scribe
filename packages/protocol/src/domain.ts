import { z } from 'zod';

export const ItemId = z.string().regex(/^[0-9A-HJKMNP-TV-Z]{26}$/, 'ULID');
export type ItemId = z.infer<typeof ItemId>;

export const PingRequest = z.object({});
export const PingResponse = z.object({ message: z.literal('pong'), bootedAt: z.string() });

export const CoreStatus = z.object({
  healthy: z.boolean(),
  uptimeSec: z.number(),
});
export type CoreStatus = z.infer<typeof CoreStatus>;

export const CaptureSource = z.enum(['voice_at_cursor', 'log_capture', 'meeting', 'web', 'email']);
export type CaptureSource = z.infer<typeof CaptureSource>;

export const Visibility = z.enum(['hidden', 'visible']);
export type Visibility = z.infer<typeof Visibility>;

export const VoiceCapturedParams = z.object({
  text: z.string(),
  source: CaptureSource,
  visibility: Visibility,
  capturedAt: z.string(), // ISO-8601 timestamp
});
export type VoiceCapturedParams = z.infer<typeof VoiceCapturedParams>;

export const SettingsSchema = z.object({
  hotkeyBinding: z.string().default('cmd+shift+space'),
});
export type Settings = z.infer<typeof SettingsSchema>;

export const SettingsPatchSchema = SettingsSchema.partial();
export type SettingsPatch = z.infer<typeof SettingsPatchSchema>;
