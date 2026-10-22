import { z } from 'zod';
import { VOICE_EVENT_TYPES } from '../services/voiceAgent.js';

export const startVoiceSessionSchema = z.object({
  campaignId: z.number().int().positive(),
  leadId: z.number().int().positive(),
});

export const voiceTurnSchema = z.object({
  type: z.enum(VOICE_EVENT_TYPES),
  text: z.string().trim().max(2000).optional().default(''),
  digit: z.string().trim().max(4).optional().default(''),
});

export const endVoiceSessionSchema = z.object({
  reason: z.string().trim().max(200).optional().default('operator_ended'),
});
