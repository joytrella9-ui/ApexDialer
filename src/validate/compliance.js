import { z } from 'zod';

// Declaration schemas for the fail-closed dialer compliance gate. These describe
// operator-asserted configuration/consent; they do not verify anything with a
// carrier and never enable live calling or recording on their own.
const iso2 = z.string().trim().regex(/^[A-Z]{2}$/);

export const complianceProfileSchema = z
  .object({
    businessName: z.string().trim().min(1).max(200),
    legalIdentity: z.string().trim().min(1).max(300),
    consentPurpose: z.string().trim().min(1).max(100).default('sales'),
    consentBasis: z
      .enum(['none', 'express_written', 'express_verbal', 'existing_customer'])
      .default('none'),
    aiDisclosure: z.string().trim().min(1).max(1000),
    recordingAllowed: z.boolean().optional().default(false),
    recordingDisclosure: z.string().trim().max(1000).optional().default(''),
    allowedCountries: z.array(iso2).max(50).optional().default(['US']),
    retentionDays: z.number().int().min(0).max(3650).optional().default(30),
  })
  .strict();

export const consentRecordSchema = z
  .object({
    phone: z.string().trim().min(1).max(40),
    channel: z.enum(['voice', 'sms']).default('voice'),
    purpose: z.string().trim().min(1).max(100).default('sales'),
    status: z.enum(['granted', 'revoked']).default('granted'),
    evidence: z.string().trim().max(2000).optional().default(''),
    source: z.string().trim().max(200).optional().default(''),
    businessName: z.string().trim().max(200).optional().default(''),
    consentedAt: z.string().trim().max(40).optional().default(''),
  })
  .strict();

export const revokeConsentSchema = z
  .object({
    phone: z.string().trim().min(1).max(40),
    channel: z.enum(['voice', 'sms']).default('voice'),
    purpose: z.string().trim().min(1).max(100).default('sales'),
  })
  .strict();
