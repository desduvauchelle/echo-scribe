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
