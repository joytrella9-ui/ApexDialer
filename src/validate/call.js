import { z } from 'zod';

export const ACTIVE_STATUSES = ['in_progress', 'paused'];

export const DISPOSITIONS = [
  'Connected',
  'Interested',
  'Not interested',
  'Callback',
  'No answer',
  'Voicemail',
  'Add to DNC',
];

export const attemptSchema = z.object({
  leadId: z.number().int('leadId must be an integer').positive('leadId must be positive'),
});

export const endAttemptSchema = z.object({
  // Left optional so the service can return a dedicated `disposition_required`
  // error instead of a generic validation_error.
  disposition: z.string().trim().max(80, 'disposition is too long').optional(),
  notes: z.string().trim().max(4000, 'notes are too long').optional().default(''),
  durationSeconds: z
    .number()
    .int('durationSeconds must be an integer')
    .min(0, 'durationSeconds cannot be negative')
    .max(86400, 'durationSeconds is too large')
    .optional(),
  addToDnc: z.boolean().optional().default(false),
});

export const abortSchema = z.object({
  reason: z.string().trim().max(200, 'reason is too long').optional().default(''),
});

export const skipSchema = z.object({
  leadId: z.number().int('leadId must be an integer').positive('leadId must be positive'),
});
