import { z } from 'zod';

export const USERNAME_PATTERN = /^[a-zA-Z0-9._-]+$/;

export const passwordSchema = z
  .string()
  .min(12, 'password must be at least 12 characters long')
  .max(72, 'password is too long (max 72 characters)');

export const usernameSchema = z
  .string()
  .trim()
  .min(3, 'username must be at least 3 characters long')
  .max(50, 'username is too long')
  .regex(USERNAME_PATTERN, 'username may contain letters, numbers, and . _ - only');

export const setupSchema = z.object({
  username: usernameSchema,
  password: passwordSchema,
  displayName: z.string().trim().max(80).optional().default(''),
});

export const loginSchema = z.object({
  username: z.string().trim().min(1, 'username is required'),
  password: z.string().min(1, 'password is required'),
});

export const changePasswordSchema = z.object({
  currentPassword: z.string().min(1, 'current password is required'),
  newPassword: passwordSchema,
});