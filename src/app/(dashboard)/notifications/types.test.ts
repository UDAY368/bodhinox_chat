import { readFileSync } from 'node:fs';
import path from 'node:path';
import { expect, it } from 'vitest';

// The page asks for `types.${n.type}` at runtime, which the literal-key messages test cannot see.
it('has a translated label for every notification type with an icon, in every locale', () => {
  const page = readFileSync(path.join(__dirname, 'page.tsx'), 'utf8');
  const block = page.match(/const TYPE_ICON[^{]*\{([^}]*)\}/)?.[1] ?? '';
  const types = [...block.matchAll(/^\s*(\w+):/gm)].map((m) => m[1]);
  expect(types).toContain('billing');
  for (const locale of ['en', 'es', 'pt', 'ko']) {
    const messages = JSON.parse(readFileSync(path.join(process.cwd(), 'messages', `${locale}.json`), 'utf8'));
    for (const type of types) expect(messages.Notifications.types[type], `${locale}: Notifications.types.${type}`).toBeTruthy();
  }
});
