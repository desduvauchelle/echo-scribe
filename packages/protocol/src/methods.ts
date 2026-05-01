import { PingRequest, PingResponse } from './domain.ts';

export const Methods = {
  'system.ping': { params: PingRequest, result: PingResponse },
} as const;

export type MethodName = keyof typeof Methods;
