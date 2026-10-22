import { z } from 'zod';
import { HttpError } from '../lib/errors.js';
import { voiceScript } from '../services/voiceAgent.js';

// =============================================================================
// AI TOOL ALLOWLIST (untrusted model -> strict, server-side validation)
// =============================================================================
// A real-time AI model may request application actions ONLY through this fixed
// allowlist. Every tool call is treated as hostile input: the name must be on the
// list and the arguments are parsed through a strict schema (`.strict()` rejects
// unknown keys, every string is length-capped). A model can therefore never
// invent an action, fabricate an offer/price, or reach a capability that is not
// explicitly granted here. Free-text responses are impossible by design: the
// model may only select a pre-approved line key that is rendered from the
// configured script.
export const AI_TOOL_NAMES = Object.freeze([
  'approved_response',
  'keypad_routing',
  'opt_out',
  'callback_request',
  'transfer_request',
  'end_call',
]);

// The only scripted lines the model is allowed to have spoken. Resolved from the
// configured `voiceScript`, never from model-supplied text.
export const APPROVED_LINE_KEYS = Object.freeze([
  'greeting',
  'disclosure',
  'reprompt',
  'callbackPrompt',
  'transfer',
  'goodbye',
  'optOut',
]);

const schemas = {
  // The model picks a line; it cannot supply arbitrary text.
  approved_response: z.object({ lineKey: z.enum(APPROVED_LINE_KEYS) }).strict(),
  // A single DTMF digit, validated against the IVR digit set later.
  keypad_routing: z.object({ digit: z.string().trim().regex(/^[0-9*#]$/) }).strict(),
  // Opt-out must be explicit; `confirm` guards against an accidental tool fire.
  opt_out: z
    .object({
      confirm: z.literal(true),
      reason: z.string().trim().max(200).optional().default(''),
    })
    .strict(),
  callback_request: z
    .object({ when: z.string().trim().max(120).optional().default('') })
    .strict(),
  transfer_request: z
    .object({ reason: z.string().trim().max(200).optional().default('') })
    .strict(),
  end_call: z.object({ reason: z.string().trim().max(200).optional().default('') }).strict(),
};

export const AI_TOOL_SCHEMAS = Object.freeze(schemas);

export function isAllowedTool(name) {
  return typeof name === 'string' && Object.prototype.hasOwnProperty.call(schemas, name);
}

// Validate one tool call's arguments. Throws a 400 HttpError on any deviation so
// the caller (executor) can reject and audit the attempt without side effects.
export function validateToolArguments(name, args) {
  if (!isAllowedTool(name)) throw new HttpError(400, 'tool_not_allowed', { tool: String(name ?? '') });
  let parsed;
  try {
    parsed = schemas[name].parse(args ?? {});
  } catch {
    throw new HttpError(400, 'invalid_tool_arguments', { tool: name });
  }
  return parsed;
}

// Normalize a raw tool call from the provider transport. `args` may be an object
// or a JSON string (as OpenAI Realtime sends it). Unknown/invalid calls throw.
export function normalizeToolCall(raw = {}) {
  const name = String(raw?.name ?? '').trim();
  if (!isAllowedTool(name)) throw new HttpError(400, 'tool_not_allowed', { tool: name });
  let args = raw?.arguments;
  if (args === undefined) args = raw?.args;
  if (args === undefined) args = {};
  if (typeof args === 'string') {
    try {
      args = args.trim() === '' ? {} : JSON.parse(args);
    } catch {
      throw new HttpError(400, 'invalid_tool_arguments', { tool: name });
    }
  }
  if (args === null || typeof args !== 'object' || Array.isArray(args)) {
    throw new HttpError(400, 'invalid_tool_arguments', { tool: name });
  }
  const callId = String(raw?.callId ?? raw?.call_id ?? '').trim().slice(0, 200);
  return { name, args: validateToolArguments(name, args), callId };
}

// Render an approved line from the configured script. If the key is unknown this
// returns the reprompt — the safe default — never model-supplied text.
export function resolveApprovedResponse(lineKey, script = voiceScript()) {
  if (!APPROVED_LINE_KEYS.includes(lineKey)) return script.reprompt;
  return script[lineKey] ?? script.reprompt;
}

// Tool definitions handed to the model for a realtime session. Kept in lockstep
// with `schemas` so the advertised surface can never exceed the validator.
export function buildRealtimeTools() {
  return [
    {
      type: 'function',
      name: 'approved_response',
      description: 'Speak one pre-approved scripted line. Useful for the greeting, disclosure, reprompt, transfer, goodbye, or opt-out acknowledgement.',
      parameters: {
        type: 'object',
        properties: { lineKey: { type: 'string', enum: [...APPROVED_LINE_KEYS] } },
        required: ['lineKey'],
        additionalProperties: false,
      },
    },
    {
      type: 'function',
      name: 'keypad_routing',
      description: 'Route the call based on a DTMF keypad digit the caller pressed.',
      parameters: {
        type: 'object',
        properties: { digit: { type: 'string', pattern: '^[0-9*#]$' } },
        required: ['digit'],
        additionalProperties: false,
      },
    },
    {
      type: 'function',
      name: 'opt_out',
      description: 'Honor a caller request to stop all future contact. Must be explicit.',
      parameters: {
        type: 'object',
        properties: {
          confirm: { type: 'boolean', enum: [true] },
          reason: { type: 'string', maxLength: 200 },
        },
        required: ['confirm'],
        additionalProperties: false,
      },
    },
    {
      type: 'function',
      name: 'callback_request',
      description: 'Record that the caller asked to be called back later.',
      parameters: {
        type: 'object',
        properties: { when: { type: 'string', maxLength: 120 } },
        additionalProperties: false,
      },
    },
    {
      type: 'function',
      name: 'transfer_request',
      description: 'Request a transfer to a human representative.',
      parameters: {
        type: 'object',
        properties: { reason: { type: 'string', maxLength: 200 } },
        additionalProperties: false,
      },
    },
    {
      type: 'function',
      name: 'end_call',
      description: 'End the call when the conversation is complete.',
      parameters: {
        type: 'object',
        properties: { reason: { type: 'string', maxLength: 200 } },
        additionalProperties: false,
      },
    },
  ];
}
