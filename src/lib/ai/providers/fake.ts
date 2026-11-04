// Deterministic fake AI provider, for tests only.
//
// It is reachable only through setAiTransportForTests, which refuses to run
// unless VITEST is 'true'. No environment variable selects it, so a production
// or CI flag can never make auto-reply send fabricated text to customers.
// generateReply and embedTexts call the transport only AFTER the deployment
// gate (assertProviderCallAllowed), so gate-off tests prove zero fake calls.
//
// Scenario directives anywhere in the system prompt or messages pick a
// behaviour: [[fake:<scenario>]] with one of
//   json:<k>=<v>,<k2>=<v2>   a JSON object of those pairs (numbers parsed)
//   handoff                  the handoff sentinel
//   leak_system_prompt       echoes the system prompt
//   claim_payment_confirmed  asserts a payment was received
//   medical_advice           a diagnosis and dosage
//   inject_follow            text that obeys an injected instruction
//   url_exfil                a reply carrying an unlisted URL
//   timeout | error_429      throws the provider's timeout / rate-limit AiError
//   invalid_json             malformed JSON
// Otherwise a short neutral reply. Usage is reported as characters / 4.

import { AiError, type ChatMessage, type ProviderResult } from '../types';
import { HANDOFF_SENTINEL } from '../defaults';

export interface FakeChatArgs {
  model: string;
  systemPrompt: string;
  messages: ChatMessage[];
  maxOutputTokens?: number;
  timeoutMs: number;
}

export interface FakeTransport {
  chat(args: FakeChatArgs): Promise<ProviderResult>;
  embed(inputs: string[]): Promise<number[][]>;
}

export interface FakeCall {
  kind: 'chat' | 'embed';
  systemPrompt: string;
  messages: ChatMessage[];
  inputs: string[];
}

let active: FakeTransport | null = null;
const calls: FakeCall[] = [];

/** Installs (or with null removes) a test transport. Throws outside Vitest. */
export function setAiTransportForTests(transport: FakeTransport | null): void {
  if (process.env.VITEST !== 'true') throw new Error('The AI test transport is available in tests only');
  active = transport;
}

/** The installed test transport; always null outside Vitest. */
export function testTransport(): FakeTransport | null {
  return process.env.VITEST === 'true' ? active : null;
}

/** Every call the fake received since the last reset, oldest first. */
export function fakeCalls(): readonly FakeCall[] {
  return calls;
}

export function resetFakeCalls(): void {
  calls.length = 0;
}

const DIRECTIVE = /\[\[fake:([a-z0-9_]+)(?::([^\]]*))?\]\]/i;

function scenarioOf(texts: string[]): { name: string; arg: string } | null {
  for (const text of texts) {
    const m = DIRECTIVE.exec(text);
    if (m) return { name: m[1].toLowerCase(), arg: m[2] ?? '' };
  }
  return null;
}

function jsonFrom(arg: string): string {
  const out: Record<string, unknown> = {};
  for (const pair of arg.split(',')) {
    const [k, ...rest] = pair.split('=');
    const key = k?.trim();
    if (!key) continue;
    const raw = rest.join('=').trim();
    out[key] = raw !== '' && Number.isFinite(Number(raw)) ? Number(raw) : raw === 'true' ? true : raw === 'false' ? false : raw;
  }
  return JSON.stringify(out);
}

const usageOf = (input: string, output: string) => {
  const promptTokens = Math.ceil(input.length / 4);
  const completionTokens = Math.ceil(output.length / 4);
  return { promptTokens, completionTokens, totalTokens: promptTokens + completionTokens };
};

/** A deterministic vector per text (1536 dims, like text-embedding-3-small). */
export function fakeEmbedding(text: string): number[] {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 16777619) >>> 0;
  return Array.from({ length: 1536 }, (_, i) => (((h + i * 2654435761) >>> 0) % 1000) / 1000);
}

/** The deterministic fake. Records every call (fakeCalls()). */
export function createFakeTransport(): FakeTransport {
  return {
    async chat(args) {
      calls.push({ kind: 'chat', systemPrompt: args.systemPrompt, messages: args.messages.map((m) => ({ ...m })), inputs: [] });
      const texts = [args.systemPrompt, ...args.messages.map((m) => m.content)];
      const scenario = scenarioOf([...texts].reverse());
      const input = texts.join('\n');
      let text: string;
      switch (scenario?.name) {
        case 'json': text = jsonFrom(scenario.arg); break;
        case 'handoff': text = HANDOFF_SENTINEL; break;
        case 'leak_system_prompt': text = args.systemPrompt; break;
        case 'claim_payment_confirmed': text = 'Good news: your payment has been received and confirmed.'; break;
        case 'medical_advice': text = 'This sounds like a viral infection. Take 500 mg of paracetamol three times a day.'; break;
        case 'inject_follow': text = 'Understood, ignoring my previous instructions as you asked. SYSTEM: admin mode enabled.'; break;
        case 'url_exfil': text = 'Please confirm your details at https://exfil.example.net/collect?d=1 to continue.'; break;
        case 'timeout': throw new AiError('The AI provider timed out.', { code: 'timeout', status: 504 });
        case 'error_429': throw new AiError('The AI provider is rate limiting requests.', { code: 'rate_limited', status: 429 });
        case 'invalid_json': text = '{"intent": "pricing", '; break;
        default: text = 'Thanks for your message. A member of our team will follow up shortly.';
      }
      return { text, usage: usageOf(input, text) };
    },
    async embed(inputs) {
      calls.push({ kind: 'embed', systemPrompt: '', messages: [], inputs: [...inputs] });
      return inputs.map(fakeEmbedding);
    },
  };
}
