/** The public app URL, so relative share images and canonical links resolve to absolute ones. */
export function publicBaseUrl(env: Record<string, string | undefined> = process.env): URL | undefined {
  const value = env.APP_URL ?? env.NEXT_PUBLIC_APP_URL;
  if (!value) return undefined;
  try {
    return new URL(value);
  } catch {
    return undefined;
  }
}
