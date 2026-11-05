/* eslint-disable @typescript-eslint/no-require-imports -- plain Node script; the scripts/*.cjs lint override does not reach subfolders */
// Appends to prisma/migration-checksums.json: sha256 of each prisma/migrations/*/migration.sql after
// normalizing CRLF to LF (production checksums come from a Linux checkout; the repo has no
// .gitattributes rule for .sql). src/lib/db/migrations-lint.test.ts fails when a listed migration
// changes, so a deployed migration cannot be edited silently. Run after adding a migration:
//   node scripts/release/migration-checksums.cjs
// Append-only: existing entries are kept, missing ones are added, and the script exits 1 naming any
// migration whose file no longer matches its recorded hash. Re-recording an entry takes an explicit
// flag, for a migration that has never been deployed:
//   node scripts/release/migration-checksums.cjs --rewrite <migration_name> [--rewrite <name> ...]
// Reads only files in this repository; touches no database.
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const dir = path.join(__dirname, '..', '..', 'prisma', 'migrations');
const out = path.join(__dirname, '..', '..', 'prisma', 'migration-checksums.json');

const rewrite = new Set();
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) {
  const arg = argv[i];
  const value = arg === '--rewrite' ? argv[++i] : arg.startsWith('--rewrite=') ? arg.slice('--rewrite='.length) : undefined;
  if (!value || !/^\d{14}_[a-z0-9_]+$/.test(value)) {
    console.error('usage: node scripts/release/migration-checksums.cjs [--rewrite <migration_name> ...]');
    process.exit(2);
  }
  rewrite.add(value);
}

const recorded = fs.existsSync(out) ? JSON.parse(fs.readFileSync(out, 'utf8')) : {};
const checksums = {};
const added = [];
const changed = [];
const rewritten = [];
for (const name of fs.readdirSync(dir).sort()) {
  const file = path.join(dir, name, 'migration.sql');
  if (!fs.existsSync(file)) continue;
  const sql = fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n');
  const hash = crypto.createHash('sha256').update(sql).digest('hex');
  if (!recorded[name]) added.push(name);
  else if (recorded[name] !== hash) {
    if (rewrite.has(name)) rewritten.push(name);
    else { changed.push(name); checksums[name] = recorded[name]; continue; }
  }
  checksums[name] = hash;
}
const unknown = [...rewrite].filter((name) => !(name in checksums));
const gone = Object.keys(recorded).filter((name) => !(name in checksums));
if (changed.length || unknown.length || gone.length) {
  for (const name of changed) console.error(`changed since recorded (deployed migrations must not change): ${name}`);
  for (const name of unknown) console.error(`--rewrite names no migration: ${name}`);
  for (const name of gone) console.error(`recorded migration is missing on disk: ${name}`);
  console.error('Nothing written.');
  process.exit(1);
}
fs.writeFileSync(out, JSON.stringify(checksums, null, 2) + '\n');
console.log(`${added.length} added, ${rewritten.length} rewritten, ${Object.keys(checksums).length} total in prisma/migration-checksums.json`);
