import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { flagsInSource, flagsMissingFromInventory, FLAGS_INVENTORY_DOC, isInventoriedSource } from './flags-inventory';

describe('[OPS-03] feature-flag inventory', () => {
  it('finds process.env and env. flag reads, once each', () => {
    const source = `if (process.env.AI_ENABLED === 'false') {}
      const on = env.INSTAGRAM_ENABLED?.trim() === 'true'; env.SHIPROCKET_DISABLED; process.env.WHATSAPP_TEMPLATES_DRY_RUN;
      process.env.AI_ENABLED; process.env.DATABASE_URL; process.env.NOT_A_FLAG_ENABLEDX`;
    expect(flagsInSource(source)).toEqual(['AI_ENABLED', 'INSTAGRAM_ENABLED', 'SHIPROCKET_DISABLED', 'WHATSAPP_TEMPLATES_DRY_RUN']);
  });

  it('reports flags not named in backticks in the inventory', () => {
    expect(flagsMissingFromInventory(['AI_ENABLED', 'ZOOM_ENABLED'], '| `AI_ENABLED` | on |\nZOOM_ENABLED without backticks'))
      .toEqual(['ZOOM_ENABLED']);
  });

  it('scans application source only', () => {
    expect(isInventoriedSource('src/lib/ai/gate.ts')).toBe(true);
    expect(isInventoriedSource('src\\app\\page.tsx')).toBe(true);
    expect(isInventoriedSource('src/lib/ai/gate.test.ts')).toBe(false);
    expect(isInventoriedSource('src/test/tenancy/fixtures.ts')).toBe(false);
    expect(isInventoriedSource('src/lib/ai/notes.md')).toBe(false);
  });

  it('every flag the application reads is in docs/release/feature-flags.md', () => {
    const root = process.cwd();
    const flags = new Set<string>();
    for (const file of fs.readdirSync(path.join(root, 'src'), { recursive: true, encoding: 'utf8' })) {
      if (!isInventoriedSource(`src/${file}`)) continue;
      for (const flag of flagsInSource(fs.readFileSync(path.join(root, 'src', file), 'utf8'))) flags.add(flag);
    }
    expect(flags.size).toBeGreaterThan(0);
    const inventory = fs.readFileSync(path.join(root, FLAGS_INVENTORY_DOC), 'utf8');
    expect(flagsMissingFromInventory(flags, inventory)).toEqual([]);
  });
});
