export function retryDecision({ attempts, maxAttempts, uncertain }: { attempts: number; maxAttempts: number; uncertain: boolean }): { status: 'pending' | 'failed'; delayMs: number } {
  if (uncertain || attempts >= maxAttempts) return { status: 'failed', delayMs: 0 };
  return { status: 'pending', delayMs: Math.min(300_000, 1000 * 2 ** attempts) };
}
