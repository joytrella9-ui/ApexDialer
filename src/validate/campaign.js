import { z } from 'zod';

export const CAMPAIGN_STATUSES = ['draft', 'running', 'paused', 'stopped', 'completed'];

export const CAMPAIGN_LEAD_STATUSES = [
  'queued',
  'dialing',
  'connected',
  'completed',
  'failed',
  'busy',
  'unanswered',
  'callback',
  'opted_out',
  'dnc',
];

// Lead statuses that mean "no further automatic action".
export const TERMINAL_LEAD_STATUSES = ['completed', 'opted_out', 'dnc', 'failed', 'connected'];

export const CALL_OUTCOMES = [
  'connected',
  'completed',
  'failed',
  'busy',
  'unanswered',
  'callback',
  'opted_out',
  'dnc',
];

const clock = /^([01]\d|2[0-3]):([0-5]\d)$/;

export const createCampaignSchema = z.object({
  name: z.string().trim().min(1, 'name is required').max(120, 'name is too long'),
  callWindowStart: z.string().trim().regex(clock, 'callWindowStart must be HH:MM').optional(),
  callWindowEnd: z.string().trim().regex(clock, 'callWindowEnd must be HH:MM').optional(),
  defaultTimezone: z.string().trim().max(64).optional(),
  maxAttempts: z.number().int().min(1).max(20).optional(),
  retryDelayMinutes: z.number().int().min(0).max(10080).optional(),
  concurrencyLimit: z.number().int().min(1).max(50).optional(),
  pacingPerMinute: z.number().int().min(1).max(600).optional(),
  ivrEnabled: z.boolean().optional(),
  aiEnabled: z.boolean().optional(),
});

export const updateCampaignSchema = createCampaignSchema.partial();

export const queueLeadsSchema = z.object({
  leadIds: z.array(z.number().int().positive()).max(5000).optional(),
  onlyEligible: z.boolean().optional().default(true),
});

export const outcomeSchema = z.object({
  leadId: z.number().int().positive(),
  outcome: z.enum(CALL_OUTCOMES),
  digit: z.string().trim().max(4).optional(),
  notes: z.string().trim().max(4000).optional().default(''),
});

export const ivrSchema = z.object({
  leadId: z.number().int().positive(),
  digit: z.string().trim().max(4).optional(),
  timedOut: z.boolean().optional().default(false),
});

export const aiTurnSchema = z.object({
  leadId: z.number().int().positive(),
  text: z.string().trim().max(2000).optional().default(''),
});

export function parseCampaignId(value) {
  const id = Number(value);
  return Number.isInteger(id) && id > 0 ? id : null;
}