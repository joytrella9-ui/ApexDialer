import { z } from 'zod';
import { isE164 } from '../providers/twilioVoice.js';
import { normalizePublicBaseUrl } from '../lib/webhookUrl.js';

const ACCOUNT_SID = /^AC[0-9a-fA-F]{32}$/;

export const e164Schema = z
  .string()
  .trim()
  .refine((v) => v === '' || isE164(v), { message: 'must be E.164 (example +15551234567)' });

export const integrationsUpdateSchema = z.object({
  twilioAccountSid: z
    .string()
    .trim()
    .optional()
    .refine((v) => v === undefined || v === '' || ACCOUNT_SID.test(v), {
      message: 'Twilio Account SID must look like ACxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx',
    }),
  twilioAuthToken: z.string().optional(),
  twilioFromNumber: e164Schema.optional(),
  agentPhone: e164Schema.optional(),
  publicBaseUrl: z
    .string()
    .trim()
    .optional()
    .superRefine((v, ctx) => {
      if (v === undefined || v === '') return;
      try {
        normalizePublicBaseUrl(v);
      } catch {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'must be an https origin with no path (Twilio cannot use localhost)' });
      }
    })
    .transform((v) => {
      if (v === undefined || v === '') return v;
      return normalizePublicBaseUrl(v);
    }),
  liveOutboundEnabled: z.boolean().optional(),
});
