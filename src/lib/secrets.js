import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { PROJECT_ROOT } from '../config.js';

function keyFilePath() {
  const dbPath = process.env.APEX_DB_PATH;
  if (dbPath && dbPath !== ':memory:') {
    return path.join(path.dirname(path.resolve(dbPath)), '.workspace-key');
  }
  return path.join(PROJECT_ROOT, 'data', '.workspace-key');
}

let cachedKey = null;

function parseKey(raw) {
  const text = String(raw ?? '').trim();
  if (!/^[0-9a-fA-F]{64}$/.test(text)) return null;
  return Buffer.from(text, 'hex');
}

export function getSecretsKey() {
  if (cachedKey) return cachedKey;
  const fromEnv = parseKey(process.env.APEX_SECRETS_KEY);
  if (fromEnv) {
    cachedKey = fromEnv;
    return cachedKey;
  }
  try {
    const keyFile = keyFilePath();
    if (existsSync(keyFile)) {
      const fromFile = parseKey(readFileSync(keyFile, 'utf8'));
      if (fromFile) {
        cachedKey = fromFile;
        return cachedKey;
      }
    }
    mkdirSync(path.dirname(keyFile), { recursive: true });
    const generated = randomBytes(32);
    writeFileSync(keyFile, generated.toString('hex'), { encoding: 'utf8', mode: 0o600 });
    cachedKey = generated;
    return cachedKey;
  } catch {
    cachedKey = randomBytes(32);
    return cachedKey;
  }
}

export function encryptSecret(plain) {
  const text = String(plain ?? '');
  if (text === '') return '';
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', getSecretsKey(), iv);
  const enc = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `v1:${iv.toString('hex')}:${tag.toString('hex')}:${enc.toString('hex')}`;
}

export function decryptSecret(stored) {
  const raw = String(stored ?? '');
  if (!raw) return '';
  const parts = raw.split(':');
  if (parts.length !== 4 || parts[0] !== 'v1') return '';
  try {
    const iv = Buffer.from(parts[1], 'hex');
    const tag = Buffer.from(parts[2], 'hex');
    const enc = Buffer.from(parts[3], 'hex');
    const decipher = createDecipheriv('aes-256-gcm', getSecretsKey(), iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(enc), decipher.final()]).toString('utf8');
  } catch {
    return '';
  }
}

export function maskSecret(value, { prefix = 2, suffix = 4 } = {}) {
  const text = String(value ?? '');
  if (!text) return '';
  if (text.length <= prefix + suffix) return '•'.repeat(Math.min(text.length, 8));
  return `${text.slice(0, prefix)}…${text.slice(-suffix)}`;
}

export function resetSecretsKeyForTests() {
  cachedKey = null;
}
