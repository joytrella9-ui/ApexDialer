import { z } from 'zod';

export const CALL_TYPES = ['sales', 'existing-customer'];
export const LEAD_STATUSES = ['pending', 'completed', 'dnc', 'blocked'];

export function countDigits(phone) {
  return String(phone).replace(/\D/g, '').length;
}

export const phoneSchema = z
  .string()
  .trim()
  .max(20, 'phone is too long')
  .refine(
    (v) => /^[+0-9().\s-]+$/.test(v) && countDigits(v) >= 7 && countDigits(v) <= 15,
    'phone must contain 7-15 digits and only digits, spaces, +, -, ( ) or .'
  );

export const consentSchema = z.object({
  status: z.enum(['none', 'recorded', 'revoked']).default('none'),
  evidence: z.string().trim().max(500).optional().default(''),
  source: z.string().trim().max(120).optional().default(''),
  date: z.string().trim().max(40).optional().default(''),
});

export const createLeadSchema = z.object({
  name: z.string().trim().min(1, 'name is required').max(120, 'name is too long'),
  phone: phoneSchema,
  company: z.string().trim().max(120).optional().default(''),
  callType: z.enum(CALL_TYPES).optional().default('sales'),
  timezone: z.string().trim().max(64).optional().default(''),
  consent: consentSchema.optional(),
  notes: z.string().trim().max(4000).optional().default(''),
});

export function parseLead(input) {
  const parsed = createLeadSchema.parse(input);
  const consent = parsed.consent ?? {};
  return {
    name: parsed.name,
    phone: parsed.phone,
    company: parsed.company,
    call_type: parsed.callType,
    timezone: parsed.timezone,
    consent_status: consent.status ?? 'none',
    consent_evidence: consent.evidence ?? '',
    consent_source: consent.source ?? '',
    consent_date: consent.date ?? '',
    status: 'pending',
    disposition: '',
    notes: parsed.notes,
    suppression_blocked: 0,
  };
}