import { z } from 'zod';
import {
  PingRequest,
  PingResponse,
  VoiceCapturedParams,
  ItemId,
  SettingsSchema,
  SettingsPatchSchema,
} from './domain.ts';

export const Methods = {
  'system.ping': { params: PingRequest, result: PingResponse },
  'voice.captured': {
    params: VoiceCapturedParams,
    result: z.object({ itemId: ItemId }),
  },
  'system.getSettings': {
    params: z.object({}),
    result: SettingsSchema,
  },
  'system.updateSettings': {
    params: z.object({ patch: SettingsPatchSchema }),
    result: SettingsSchema,
  },
} as const;

export type MethodName = keyof typeof Methods;
