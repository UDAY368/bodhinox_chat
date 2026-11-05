// Seeds the pilot-volume performance database (design section 2). Local Docker only.
//
//   npm run perf:seed -- [--profile pilot|stress]
//
// Creates (or recreates) the database `bodhinox_perf` on the local Docker PostgreSQL that
// `node scripts/test-db-local.cjs setup` runs, applies every migration and the role logins to it with an
// isolated environment (scripts/perf/perf-env.ts), then inserts synthetic, deterministic rows as the
// owner: generate_series with hash-derived values, so two runs produce the same data relative to the
// seed time. Never part of CI or test:all:local. `node scripts/test-db-local.cjs stop` removes it.
//
// The domain outbox triggers (emit_domain_outbox_event on contacts, conversations, messages) are
// disabled for the seed only and re-enabled after: the queries measured never read outbox_events, and
// 100k serialized outbox rows per tenant would only slow the seed. The report says so.
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import pg from 'pg';
import { assertLocalPerfUrl, isolatedPerfEnv, PERF_DATABASE, perfDatabaseUrls, readDockerEnv } from './perf-env';

export const PROFILES = {
  pilot: { contacts: 5_000, conversations: 5_000, messages: 100_000, orders: 1_000, appointments: 2_000, staff: 10 },
  stress: { contacts: 50_000, conversations: 50_000, messages: 500_000, orders: 1_000, appointments: 2_000, staff: 10 },
} as const;
export type ProfileName = keyof typeof PROFILES;
type Volume = { contacts: number; conversations: number; messages: number; orders: number; appointments: number; staff: number };
/** The noise tenant: a small third workspace so per-tenant indexes are exercised with other rows present. */
const NOISE: Volume = { contacts: 500, conversations: 500, messages: 5_000, orders: 100, appointments: 200, staff: 3 };

const root = path.resolve(__dirname, '..', '..');

function profileArg(argv: string[]): ProfileName {
  const i = argv.indexOf('--profile');
  const value = i >= 0 ? argv[i + 1] : argv.find((a) => a.startsWith('--profile='))?.slice('--profile='.length) ?? 'pilot';
  if (value !== 'pilot' && value !== 'stress') throw new Error('--profile must be pilot or stress');
  return value;
}

function run(args: string[], env: NodeJS.ProcessEnv) {
  const result = spawnSync(process.execPath, args, { cwd: root, env, stdio: ['ignore', 'ignore', 'inherit'] });
  if (result.status !== 0) throw new Error(`${path.basename(args[0])} failed`);
}

/** Deterministic tenant ids (RFC 4122 v4 shape, which withTenant requires). */
export const TENANT_KEYS = ['perf-tenant-1', 'perf-tenant-2', 'perf-noise'] as const;

const SEED_SQL = `
CREATE FUNCTION pg_temp.pid(t text) RETURNS uuid LANGUAGE sql IMMUTABLE AS $$
  SELECT (substr(h,1,12) || '4' || substr(h,14,3) || '8' || substr(h,18,15))::uuid FROM (SELECT md5(t) AS h) x $$;
CREATE FUNCTION pg_temp.pick(arr text[], i bigint) RETURNS text LANGUAGE sql IMMUTABLE AS $$
  SELECT arr[1 + (abs(hashtext(i::text)) % array_length(arr,1))] $$;
`;

/** One workspace, seeded in one transaction. $1 tenant key, $2 phone prefix digit, $3 reference time, $4 encrypted dummy token (substituted with transaction settings). */
function tenantSql(v: Volume): string {
  const first = `ARRAY['Asha','Ravi','Kumar','Priya','Arjun','Meera','Vikram','Divya','Rahul','Sneha','Kiran','Anita','Suresh','Lakshmi','Manoj','Pooja','Deepak','Kavya','Nikhil','Rekha']`;
  const last = `ARRAY['Sharma','Iyer','Reddy','Nair','Gupta','Patel','Rao','Menon','Kumari','Singh','Das','Joshi','Pillai','Kapoor','Bose']`;
  const words = `ARRAY['hello','price','order','delivery','thanks','booking','available','size','colour','payment','address','tomorrow','discount','return','status']`;
  return `
SELECT set_config('app.account_id', pg_temp.pid($1)::text, true), set_config('app.account_role', 'owner', true);
INSERT INTO auth_users(id,email,full_name,password_hash,email_verified_at)
  SELECT pg_temp.pid($1||'-user-'||i), $1||'-staff-'||i||'@example.com', 'Perf staff '||i, 'perf-not-a-hash', $3::timestamptz
  FROM generate_series(1,${v.staff}) i;
INSERT INTO accounts(id,name,owner_user_id) VALUES(pg_temp.pid($1), 'Perf workspace '||$1, pg_temp.pid($1||'-user-1'));
INSERT INTO account_memberships(account_id,user_id,role)
  SELECT pg_temp.pid($1), pg_temp.pid($1||'-user-'||i), CASE WHEN i=1 THEN 'owner' WHEN i<=3 THEN 'admin' WHEN i=${v.staff} THEN 'viewer' ELSE 'agent' END
  FROM generate_series(1,${v.staff}) i;
INSERT INTO profiles(user_id,email,full_name,account_id,account_role)
  SELECT pg_temp.pid($1||'-user-'||i), $1||'-staff-'||i||'@example.com', 'Perf staff '||i, pg_temp.pid($1),
    CASE WHEN i=1 THEN 'owner' WHEN i<=3 THEN 'admin' WHEN i=${v.staff} THEN 'viewer' ELSE 'agent' END
  FROM generate_series(1,${v.staff}) i;
INSERT INTO whatsapp_config(id,account_id,user_id,phone_number_id,waba_id,access_token,status,is_default,display_name)
  VALUES(pg_temp.pid($1||'-number'), pg_temp.pid($1), pg_temp.pid($1||'-user-1'), '9'||$2||'0000000001', 'perf-waba-'||$2, $4, 'connected', true, 'Perf line');
INSERT INTO tags(id,account_id,user_id,name)
  SELECT pg_temp.pid($1||'-tag-'||i), pg_temp.pid($1), pg_temp.pid($1||'-user-1'), 'perf-tag-'||i FROM generate_series(1,20) i;
INSERT INTO contacts(id,account_id,user_id,phone,name,email,created_at)
  SELECT pg_temp.pid($1||'-contact-'||i), pg_temp.pid($1), pg_temp.pid($1||'-user-1'),
    '+91 98'||$2||lpad(i::text,7,'0'),
    pg_temp.pick(${first}, i)||' '||pg_temp.pick(${last}, i*31),
    CASE WHEN i%3=0 THEN 'customer'||i||'@example.com' END,
    $3::timestamptz - make_interval(mins => (i*97 % 259200)::int)
  FROM generate_series(1,${v.contacts}) i;
INSERT INTO contact_tags(account_id,contact_id,tag_id)
  SELECT pg_temp.pid($1), pg_temp.pid($1||'-contact-'||i), pg_temp.pid($1||'-tag-'||(1 + i%20)) FROM generate_series(1,${v.contacts}) i
  UNION ALL
  SELECT pg_temp.pid($1), pg_temp.pid($1||'-contact-'||i), pg_temp.pid($1||'-tag-'||(1 + (i*7+3)%20)) FROM generate_series(1,${v.contacts}) i
    WHERE i%3=0 AND (1 + i%20) <> (1 + (i*7+3)%20);
INSERT INTO conversations(id,account_id,user_id,contact_id,whatsapp_config_id,status,last_message_text,last_message_at,unread_count,assigned_agent_id,created_at)
  SELECT pg_temp.pid($1||'-conv-'||i), pg_temp.pid($1), pg_temp.pid($1||'-user-1'), pg_temp.pid($1||'-contact-'||(1 + (i-1) % ${v.contacts})),
    pg_temp.pid($1||'-number'), CASE WHEN i%4=0 THEN 'closed' ELSE 'open' END,
    pg_temp.pick(${words}, i)||' '||pg_temp.pick(${words}, i*13),
    $3::timestamptz - make_interval(mins => (i*37 % 43200)::int), i%5,
    CASE WHEN i%3=0 THEN pg_temp.pid($1||'-user-'||(1 + i % ${v.staff})) END,
    $3::timestamptz - make_interval(mins => (i*37 % 43200)::int + 1440)
  FROM generate_series(1,${v.conversations}) i;
INSERT INTO messages(account_id,conversation_id,sender_type,content_type,content_text,status,message_id,created_at,sender_id)
  SELECT pg_temp.pid($1), pg_temp.pid($1||'-conv-'||c), CASE WHEN j%2=0 THEN 'customer' ELSE 'agent' END, 'text',
    pg_temp.pick(${words}, j)||' '||pg_temp.pick(${words}, j*7)||' '||pg_temp.pick(${words}, j*11),
    CASE WHEN j%2=0 THEN 'delivered' ELSE 'read' END, 'wamid.perf'||$2||'.'||j,
    $3::timestamptz - make_interval(mins => (c*37 % 43200)::int) - make_interval(mins => ((j-1) / ${v.conversations})::int * 7),
    CASE WHEN j%2=1 THEN pg_temp.pid($1||'-user-'||(1 + j % ${v.staff})) END
  FROM (SELECT j, 1 + (j-1) % ${v.conversations} AS c FROM generate_series(1,${v.messages}) j) s;
INSERT INTO orders(account_id,source,contact_id,conversation_id,whatsapp_config_id,currency,subtotal_minor,total_minor,created_at)
  SELECT pg_temp.pid($1), 'manual', pg_temp.pid($1||'-contact-'||(1 + (i*5) % ${v.contacts})), pg_temp.pid($1||'-conv-'||(1 + (i*5) % ${v.conversations})),
    pg_temp.pid($1||'-number'), 'INR', 10000 + (abs(hashtext(i::text)) % 90000), 10000 + (abs(hashtext(i::text)) % 90000),
    $3::timestamptz - make_interval(hours => (i*13 % 1440)::int)
  FROM generate_series(1,${v.orders}) i;
INSERT INTO appointment_services(id,account_id,name,mode,duration_minutes) VALUES(pg_temp.pid($1||'-service'), pg_temp.pid($1), 'Consult', 'offline', 30);
INSERT INTO appointment_locations(id,account_id,name,timezone) VALUES(pg_temp.pid($1||'-location'), pg_temp.pid($1), 'Office', 'Asia/Kolkata');
INSERT INTO appointments(account_id,contact_id,service_id,location_id,start_at,end_at,timezone,status,source,service_name)
  SELECT pg_temp.pid($1), pg_temp.pid($1||'-contact-'||(1 + (i*11) % ${v.contacts})), pg_temp.pid($1||'-service'), pg_temp.pid($1||'-location'),
    date_trunc('hour', $3::timestamptz) + make_interval(hours => (i % 1440)::int - 720), date_trunc('hour', $3::timestamptz) + make_interval(hours => (i % 1440)::int - 720, mins => 30),
    'Asia/Kolkata', CASE WHEN i % 1440 < 720 THEN 'completed' ELSE 'confirmed' END, 'staff', 'Consult'
  FROM generate_series(1,${v.appointments}) i;
`;
}

async function main() {
  const profile = profileArg(process.argv.slice(2));
  const docker = readDockerEnv(root);
  const urls = perfDatabaseUrls(docker);
  // The admin connection for CREATE DATABASE uses the Docker owner login on its own test database.
  const admin = new URL(docker.MIGRATION_DATABASE_URL);
  const adminCheck = new URL(admin.toString());
  adminCheck.pathname = `/${PERF_DATABASE}`;
  assertLocalPerfUrl('MIGRATION_DATABASE_URL', adminCheck.toString());
  const started = Date.now();
  const server = new pg.Client({ connectionString: admin.toString() });
  await server.connect();
  try {
    await server.query(`DROP DATABASE IF EXISTS ${PERF_DATABASE} WITH (FORCE)`);
    await server.query(`CREATE DATABASE ${PERF_DATABASE}`);
  } finally { await server.end(); }

  const env = isolatedPerfEnv(process.env, urls);
  run(['node_modules/prisma/build/index.js', 'migrate', 'deploy'], env);
  run(['node_modules/tsx/dist/cli.mjs', 'scripts/db-bootstrap-roles.ts'], env);
  const migratedAt = Date.now();

  process.env.ENCRYPTION_KEY = env.ENCRYPTION_KEY;
  const { encrypt } = await import('../../src/lib/whatsapp/encryption');
  const owner = new pg.Client({ connectionString: urls.MIGRATION_DATABASE_URL });
  await owner.connect();
  const reference = new Date();
  const volumes: Record<string, Volume> = { 'perf-tenant-1': PROFILES[profile], 'perf-tenant-2': PROFILES[profile], 'perf-noise': NOISE };
  try {
    await owner.query(SEED_SQL);
    for (const table of ['contacts', 'conversations', 'messages']) await owner.query(`ALTER TABLE ${table} DISABLE TRIGGER domain_outbox`);
    for (const [index, key] of TENANT_KEYS.entries()) {
      await owner.query('BEGIN');
      // The per-tenant values travel as transaction settings, so the statements need no parameters.
      await owner.query("SELECT set_config('perf.key',$1,true), set_config('perf.digit',$2,true), set_config('perf.ref',$3,true), set_config('perf.token',$4,true)",
        [key, String(index + 1), reference.toISOString(), encrypt(`perf-dummy-token-${key}`)]);
      const sql = tenantSql(volumes[key]).replaceAll('$1', "current_setting('perf.key')").replaceAll('$2', "current_setting('perf.digit')")
        .replaceAll('$3', "current_setting('perf.ref')").replaceAll('$4', "current_setting('perf.token')");
      for (const statement of sql.split(/;\s*\n/).map((s) => s.trim()).filter(Boolean)) await owner.query(statement);
      await owner.query('COMMIT');
    }
    for (const table of ['contacts', 'conversations', 'messages']) await owner.query(`ALTER TABLE ${table} ENABLE TRIGGER domain_outbox`);
    await owner.query('ANALYZE');
    const counts = (await owner.query(`SELECT (SELECT count(*) FROM contacts)::int AS contacts, (SELECT count(*) FROM conversations)::int AS conversations,
      (SELECT count(*) FROM messages)::int AS messages, (SELECT count(*) FROM orders)::int AS orders, (SELECT count(*) FROM appointments)::int AS appointments`)).rows[0];
    console.log(JSON.stringify({
      seeded: PERF_DATABASE, profile, perTenant: PROFILES[profile], noiseTenant: NOISE, totals: counts, referenceTime: reference.toISOString(),
      outboxTriggers: 'disabled during the seed only, re-enabled after', migrateAndRolesS: Math.round((migratedAt - started) / 100) / 10,
      seedS: Math.round((Date.now() - migratedAt) / 100) / 10, host: { cpu: os.cpus()[0]?.model ?? null, cpus: os.cpus().length },
    }, null, 2));
  } catch (error) {
    await owner.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally { await owner.end(); }
}

main().catch((error: unknown) => {
  // Synthetic local data only, but print the error class and message, never a URL.
  console.error('[perf:seed] failed:', error instanceof Error ? `${error.name}: ${error.message.replace(/postgres(ql)?:\/\/\S+/g, '<url>')}` : 'Error');
  process.exit(1);
});
