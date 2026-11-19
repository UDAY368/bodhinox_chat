// Client-safe constants of the AI product writer (product-writer.ts pulls in the server-only generators).
export const WRITER_TONES = ['friendly', 'professional', 'playful', 'luxury', 'simple'] as const
export type WriterTone = (typeof WRITER_TONES)[number]
export const WRITER_LIMITS = { name: 200, attributes: 10, attribute: 100, description: 2000 } as const
