import { z } from 'zod';
import { ROLES } from '../middleware/policy.js';
import { usernameSchema, passwordSchema } from './auth.js';

const roleSchema = z.enum(ROLES, { errorMap: () => ({ message: `role must be one of: ${ROLES.join(', ')}` }) });

export const createUserSchema = z.object({
  username: usernameSchema,
  password: passwordSchema,
  displayName: z.string().trim().max(80).optional().default(''),
  role: roleSchema.optional().default('operator'),
});

export const updateUserSchema = z
  .object({
    role: roleSchema.optional(),
    disabled: z.boolean().optional(),
  })
  .refine((v) => v.role !== undefined || v.disabled !== undefined, {
    message: 'provide role and/or disabled',
  });
