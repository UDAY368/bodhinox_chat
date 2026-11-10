// Stage 2 (2E): the conversation-starters form refuses what the server would
// (at most 4, 80 characters, distinct questions, a chosen Instagram flow), so
// an admin never publishes a list Instagram or the API refuses.
import { describe, expect, it } from 'vitest';
import { startersProblem } from './conversation-starters-editor';

const F1 = '11111111-1111-4111-8111-111111111111';
const flows = new Set([F1]);

describe('startersProblem', () => {
  it('accepts up to 4 distinct questions, each with a flow', () => {
    expect(startersProblem([], flows)).toBeNull();
    expect(startersProblem(['A', 'B', 'C', 'D'].map((q) => ({ question: q, flowId: F1 })), flows)).toBeNull();
  });

  it('names the first problem', () => {
    expect(startersProblem(['A', 'B', 'C', 'D', 'E'].map((q) => ({ question: q, flowId: F1 })), flows)).toBe('max');
    expect(startersProblem([{ question: '  ', flowId: F1 }], flows)).toBe('question');
    expect(startersProblem([{ question: 'x'.repeat(81), flowId: F1 }], flows)).toBe('tooLong');
    expect(startersProblem([{ question: '🙂'.repeat(80), flowId: F1 }], flows)).toBeNull();
    expect(startersProblem([{ question: 'Hours', flowId: F1 }, { question: ' hours ', flowId: F1 }], flows)).toBe('duplicate');
    expect(startersProblem([{ question: 'Hours', flowId: '' }], flows)).toBe('flow');
    expect(startersProblem([{ question: 'Hours', flowId: '22222222-2222-4222-8222-222222222222' }], flows)).toBe('flow');
  });
});
