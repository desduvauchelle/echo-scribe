import { CoreStatus } from './domain.ts';

export const Events = {
  'core.status': CoreStatus,
} as const;

export type EventName = keyof typeof Events;
