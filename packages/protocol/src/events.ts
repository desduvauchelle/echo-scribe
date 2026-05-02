import { CoreStatus, SettingsSchema } from './domain.ts';

export const Events = {
  'core.status': CoreStatus,
  'settings.changed': SettingsSchema,
} as const;

export type EventName = keyof typeof Events;
