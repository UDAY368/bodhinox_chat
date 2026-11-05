// Starts `next dev` for Playwright against the isolated test database only.
// .env.test values win; any other key from .env.local (production SMTP, Meta,
// AI keys, ...) is blanked so a test run can never reach a live service.
const fs = require('node:fs');
const path = require('node:path');
const { parse } = require('dotenv');

const root = path.resolve(__dirname, '..');
const read = (name) => {
  const file = path.join(root, name);
  return fs.existsSync(file) ? parse(fs.readFileSync(file)) : {};
};
// test-db-local.cjs sets DATABASE_ENV_FILE to point the run at the local Docker database.
const test = { ...read('.env.test'), ...(process.env.DATABASE_ENV_FILE ? read(process.env.DATABASE_ENV_FILE) : {}) };
for (const key of Object.keys(read('.env.local'))) if (!(key in test)) process.env[key] = '';
Object.assign(process.env, test);

const port = process.env.E2E_PORT || '3100';
process.env.APP_URL = `http://localhost:${port}`;
// Phase 15 journeys. Mail goes only to the local capture e2e/global-setup starts on
// 127.0.0.1 (e2e/smtp-capture.ts), and Meta webhooks are signed with a test-only
// secret the specs share (e2e/journeys.ts). Never a real SMTP server or app secret.
process.env.SMTP_URL = `smtp://127.0.0.1:${process.env.E2E_SMTP_PORT || '3125'}`;
process.env.AUTH_EMAIL_FROM = 'e2e@example.invalid';
process.env.META_APP_SECRET = 'e2e-only-meta-app-secret';
delete process.env.META_APP_SECRET_PRIMARY;
for (const key of ['DATABASE_URL', 'AUTH_DATABASE_URL', 'WORKER_DATABASE_URL']) {
  const name = (() => { try { return new URL(process.env[key]).pathname; } catch { return ''; } })();
  if (!/test/i.test(name)) {
    console.error(`refusing to start: ${key} is not a test database`);
    process.exit(1);
  }
}

process.chdir(root);
process.argv = [process.argv[0], 'next', 'dev', '-p', port];
require(path.join(root, 'node_modules/next/dist/bin/next'));
