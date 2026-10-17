/** Read the operator-managed Gemini key only in server-side AI code. */
export function geminiApiKey(): string {
  return process.env.GEMINI_API_KEY?.trim() ?? ''
}
