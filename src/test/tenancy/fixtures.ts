// Shared two-tenant fixture for Phase 15 tenancy, ordering, concurrency and route tests.
// Owner: T2 (design section 1.1). The host guard is final: the fixture only ever runs against the
// local Docker test database (127.0.0.1 / localhost / ::1, database name containing "test").
//
// Setup rows are written by the owner connection (as the existing integration tests do for
// accounts and memberships); everything a suite then probes goes through the real constrained
// roles (app/auth/worker). Synthetic data only: names "p15 ...", emails @example.invalid.
//
// vitest collects only src/**/*.test.ts(x), so this helper is never run as a test itself.
import { randomUUID } from "node:crypto";
import { exportPKCS8, exportSPKI, generateKeyPair } from "jose";
import { Pool, type PoolClient } from "pg";
import type { TenantContext } from "@/lib/db/tenant";
import { isLocalDatabaseHost, type Env } from "@/lib/db/test-db-guard";
import { generateApiKey } from "@/lib/api-keys/keys";
import { API_SCOPES } from "@/lib/api-keys/scopes";
import { encrypt } from "@/lib/whatsapp/encryption";

export type FixtureRole = "owner" | "admin" | "agent" | "viewer";
const ROLES: FixtureRole[] = ["owner", "admin", "agent", "viewer"];

/** Every DB variable the fixture may read; all must be local and name a test database. */
export const FIXTURE_DATABASE_KEYS = ["TEST_DATABASE_URL", "TEST_APP_DATABASE_URL", "TEST_AUTH_DATABASE_URL",
  "TEST_WORKER_DATABASE_URL"] as const;

export type FixtureDatabaseUrls = {
  owner: string;
  app: string;
  auth: string;
  worker: string;
};

/**
 * The fixture's connection URLs, or null when the real-database stage is not configured (callers
 * use describe.skipIf(!fixtureDatabaseUrls()) like the existing integration tests). Throws when
 * any configured URL is not local (127.0.0.1 / localhost / ::1) or its database name lacks "test".
 */
export function fixtureDatabaseUrls(env: Env = process.env): FixtureDatabaseUrls | null {
  for (const key of FIXTURE_DATABASE_KEYS) {
    const value = env[key];
    if (!value) continue;
    let url: URL;
    try { url = new URL(value); } catch { throw new Error(`${key} is not a valid URL`); }
    if (!isLocalDatabaseHost(url.hostname)) throw new Error(`${key} must point at the local test database`);
    if (!/test/i.test(url.pathname)) throw new Error(`${key} is not a test database`);
  }
  const owner = env.TEST_DATABASE_URL, app = env.TEST_APP_DATABASE_URL, auth = env.TEST_AUTH_DATABASE_URL,
    worker = env.TEST_WORKER_DATABASE_URL;
  return owner && app && auth && worker ? { owner, app, auth, worker } : null;
}

export type FixtureUser = { userId: string; email: string; role: FixtureRole; context: TenantContext };

/** One workspace with one row of each tenant-owned kind the suites probe. */
export type TenantFixture = {
  accountId: string;
  /** Owner context; users.<role>.context for the others. */
  context: TenantContext;
  users: Record<FixtureRole, FixtureUser>;
  whatsappConfigId: string;
  contactId: string;
  conversationId: string;
  messageId: string;
  orderId: string;
  appointmentId: string;
  broadcastId: string;
  webhookEndpointId: string;
  apiKeyId: string;
  /** Plain API key (shown once at creation); only for apiKeyRequest. */
  apiKey: string;
  /** Further ids by resource name for the contract suite (src/lib/data/contracts.ts resources). */
  ids: Record<string, string>;
};

export type TenantPair = { a: TenantFixture; b: TenantFixture };

export type CreateTenantPairOptions = {
  /** Prefix for names and emails (all @example.invalid); default "p15". */
  label?: string;
  /** Also create a third small "noise" workspace. */
  noise?: boolean;
};

let ownerPool: Pool | null = null;

function urls(): FixtureDatabaseUrls {
  const found = fixtureDatabaseUrls();
  if (!found) throw new Error("The tenancy fixture needs the local test database (node scripts/test-db-local.cjs)");
  return found;
}

/** Owner connection for fixture setup and cleanup only; never used to assert behaviour. */
export function fixtureOwnerPool(): Pool {
  ownerPool ??= new Pool({ connectionString: urls().owner, max: 4 });
  return ownerPool;
}

/** Points the application's Prisma clients at the local constrained roles, as existing suites do. */
export function connectFixtureDatabases(): FixtureDatabaseUrls {
  const found = urls();
  process.env.DATABASE_URL = found.app;
  process.env.AUTH_DATABASE_URL = found.auth;
  process.env.WORKER_DATABASE_URL = found.worker;
  if (process.env.TEST_PLATFORM_DATABASE_URL) process.env.PLATFORM_DATABASE_URL = process.env.TEST_PLATFORM_DATABASE_URL;
  return found;
}

export const FIXTURE_ORIGIN = "https://crm.tenancy.test";

/**
 * In-process signing keys and the app origin for the auth service, generated once per test file
 * (as crm.integration.test.ts does). Values already present are kept.
 */
export async function ensureFixtureAuthEnv(): Promise<void> {
  process.env.APP_URL ??= FIXTURE_ORIGIN;
  if (process.env.AUTH_JWT_PRIVATE_KEY && process.env.AUTH_JWT_PUBLIC_KEY) return;
  const keys = await generateKeyPair("RS256", { extractable: true });
  process.env.AUTH_JWT_PRIVATE_KEY = await exportPKCS8(keys.privateKey);
  process.env.AUTH_JWT_PUBLIC_KEY = await exportSPKI(keys.publicKey);
  process.env.AUTH_JWT_KID = "tenancy-fixture";
  process.env.AUTH_JWT_ISSUER = FIXTURE_ORIGIN;
  process.env.AUTH_JWT_AUDIENCE = "tenancy-fixture";
}

async function insert(client: PoolClient, sql: string, values: unknown[]): Promise<string> {
  const result = await client.query<{ id: string }>(`${sql} RETURNING id`, values);
  return String(result.rows[0].id);
}

async function createWorkspace(label: string, tag: string): Promise<TenantFixture> {
  const accountId = randomUUID();
  const userIds = Object.fromEntries(ROLES.map((role) => [role, randomUUID()])) as Record<FixtureRole, string>;
  const owner = userIds.owner;
  const email = (role: FixtureRole) => `${label}-${tag}-${role}-${userIds[role].slice(0, 8)}@example.invalid`;
  const users = Object.fromEntries(ROLES.map((role) => [role, {
    userId: userIds[role], email: email(role), role,
    context: { accountId, userId: userIds[role], role },
  }])) as Record<FixtureRole, FixtureUser>;
  const ids: Record<string, string> = { accounts: accountId };
  const key = generateApiKey();
  // A unique, obviously fake number per workspace (reserved +91 00000 test range is not dialable).
  const phone = `91000${Math.floor(Math.random() * 1e7).toString().padStart(7, "0")}`;
  const client = await fixtureOwnerPool().connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT set_config('app.account_id',$1,true),set_config('app.user_id',$2,true),set_config('app.account_role','owner',true)",
      [accountId, owner]);
    for (const role of ROLES)
      await client.query("INSERT INTO auth_users(id,email,full_name,password_hash,email_verified_at) VALUES($1::uuid,$2,$3,'test-only-hash',NOW())",
        [userIds[role], email(role), `${label} ${tag} ${role}`]);
    await client.query("INSERT INTO accounts(id,name,owner_user_id) VALUES($1::uuid,$2,$3::uuid)", [accountId, `${label} workspace ${tag}`, owner]);
    for (const role of ROLES) {
      await client.query("INSERT INTO account_memberships(account_id,user_id,role) VALUES($1::uuid,$2::uuid,$3)", [accountId, userIds[role], role]);
      const profile = await insert(client, "INSERT INTO profiles(user_id,email,full_name,account_id,account_role) VALUES($1::uuid,$2,$3,$4::uuid,$5)",
        [userIds[role], email(role), `${label} ${tag} ${role}`, accountId, role]);
      if (role === "owner") ids.profiles = profile;
    }
    const a = accountId, u = owner;
    ids.whatsapp_config = await insert(client, "INSERT INTO whatsapp_config(account_id,user_id,phone_number_id,waba_id,access_token,status,is_default) VALUES($1,$2,$3,$4,$5,'connected',true)",
      [a, u, `p15-${randomUUID()}`, `p15-waba-${tag}`, encrypt(`p15-dummy-token-${tag}`)]);
    ids.contacts = await insert(client, "INSERT INTO contacts(account_id,user_id,phone,name) VALUES($1,$2,$3,$4)",
      [a, u, phone, `${label} contact ${tag}`]);
    ids.conversations = await insert(client, "INSERT INTO conversations(account_id,user_id,contact_id,whatsapp_config_id,last_message_text,last_message_at) VALUES($1,$2,$3,$4,'hello',NOW())",
      [a, u, ids.contacts, ids.whatsapp_config]);
    ids.messages = await insert(client, "INSERT INTO messages(account_id,conversation_id,sender_type,content_type,content_text,status,message_id) VALUES($1,$2,'customer','text','hello','delivered',$3)",
      [a, ids.conversations, `wamid.p15${randomUUID().replaceAll("-", "")}`]);
    ids.tags = await insert(client, "INSERT INTO tags(account_id,user_id,name) VALUES($1,$2,$3)", [a, u, `${label}-tag-${tag}`]);
    ids.contact_tags = await insert(client, "INSERT INTO contact_tags(account_id,contact_id,tag_id) VALUES($1,$2,$3)", [a, ids.contacts, ids.tags]);
    ids.custom_fields = await insert(client, "INSERT INTO custom_fields(account_id,user_id,field_name) VALUES($1,$2,$3)", [a, u, `${label}_field_${tag}`]);
    ids.contact_custom_values = await insert(client, "INSERT INTO contact_custom_values(account_id,contact_id,custom_field_id,value) VALUES($1,$2,$3,'v')",
      [a, ids.contacts, ids.custom_fields]);
    ids.contact_notes = await insert(client, "INSERT INTO contact_notes(account_id,contact_id,user_id,note_text) VALUES($1,$2,$3,'note')", [a, ids.contacts, u]);
    ids.message_templates = await insert(client, "INSERT INTO message_templates(account_id,user_id,name,language,body_text) VALUES($1,$2,$3,'en_US','Hi')",
      [a, u, `${label}_tpl_${tag}`]);
    ids.pipelines = await insert(client, "INSERT INTO pipelines(account_id,user_id,name) VALUES($1,$2,'Pipeline')", [a, u]);
    ids.pipeline_stages = await insert(client, "INSERT INTO pipeline_stages(account_id,pipeline_id,name) VALUES($1,$2,'Stage')", [a, ids.pipelines]);
    ids.deals = await insert(client, "INSERT INTO deals(account_id,user_id,pipeline_id,stage_id,contact_id,title) VALUES($1,$2,$3,$4,$5,'Deal')",
      [a, u, ids.pipelines, ids.pipeline_stages, ids.contacts]);
    ids.broadcasts = await insert(client, "INSERT INTO broadcasts(account_id,user_id,name,template_name,status) VALUES($1,$2,'Broadcast',$3,'draft')",
      [a, u, `${label}_tpl_${tag}`]);
    ids.broadcast_recipients = await insert(client, "INSERT INTO broadcast_recipients(account_id,broadcast_id,contact_id) VALUES($1,$2,$3)",
      [a, ids.broadcasts, ids.contacts]);
    ids.automations = await insert(client, "INSERT INTO automations(account_id,user_id,name,trigger_type) VALUES($1,$2,'Automation','new_message')", [a, u]);
    ids.automation_steps = await insert(client, "INSERT INTO automation_steps(account_id,automation_id,step_type,position,step_config) VALUES($1,$2,'add_tag',0,$3)",
      [a, ids.automations, JSON.stringify({ tag_id: ids.tags })]);
    ids.automation_logs = await insert(client, "INSERT INTO automation_logs(account_id,automation_id,user_id,contact_id,trigger_event,status) VALUES($1,$2,$3,$4,'new_message','success')",
      [a, ids.automations, u, ids.contacts]);
    ids.automation_pending_executions = await insert(client, "INSERT INTO automation_pending_executions(account_id,automation_id,user_id,contact_id,next_step_position,run_at) VALUES($1,$2,$3,$4,1,NOW()+interval '1 day')",
      [a, ids.automations, u, ids.contacts]);
    ids.message_reactions = await insert(client, "INSERT INTO message_reactions(account_id,message_id,conversation_id,actor_type,emoji) VALUES($1,$2,$3,'customer','👍')",
      [a, ids.messages, ids.conversations]);
    ids.flows = await insert(client, "INSERT INTO flows(account_id,user_id,name,trigger_type) VALUES($1,$2,'Flow','keyword')", [a, u]);
    ids.flow_nodes = await insert(client, "INSERT INTO flow_nodes(account_id,flow_id,node_key,node_type,config) VALUES($1,$2,'start','send_message',$3)",
      [a, ids.flows, JSON.stringify({ text: "hi" })]);
    ids.flow_runs = await insert(client, "INSERT INTO flow_runs(account_id,flow_id,user_id,contact_id,conversation_id,status,current_node_key) VALUES($1,$2,$3,$4,$5,'completed','start')",
      [a, ids.flows, u, ids.contacts, ids.conversations]);
    ids.flow_run_events = await insert(client, "INSERT INTO flow_run_events(account_id,flow_run_id,event_type,node_key) VALUES($1,$2,'node_entered','start')",
      [a, ids.flow_runs]);
    ids.account_invitations = await insert(client, "INSERT INTO account_invitations(account_id,token_hash,role,created_by_user_id,expires_at) VALUES($1,$2,'agent',$3,NOW()+interval '1 day')",
      [a, randomUUID().replaceAll("-", "").repeat(2), u]);
    await client.query("INSERT INTO member_presence(account_id,user_id,status) VALUES($1,$2,'online')", [a, u]);
    ids.member_presence = u;
    ids.api_keys = await insert(client, "INSERT INTO api_keys(account_id,created_by,name,key_prefix,key_hash,scopes) VALUES($1,$2,'p15 key',$3,$4,$5)",
      [a, u, key.prefix, key.hash, [...API_SCOPES]]);
    ids.notifications = await insert(client, "INSERT INTO notifications(account_id,user_id,title,conversation_id) VALUES($1,$2,'p15 notice',$3)",
      [a, u, ids.conversations]);
    ids.webhook_endpoints = await insert(client, "INSERT INTO webhook_endpoints(account_id,created_by,url,secret,events) VALUES($1,$2,$3,$4,$5)",
      [a, u, `https://hooks.example.com/${tag}`, encrypt(`whsec_p15_${tag}_${randomUUID()}`), ["conversation.created", "message.received"]]);
    ids.ai_configs = await insert(client, "INSERT INTO ai_configs(account_id,created_by,provider,model,api_key,is_active) VALUES($1,$2,'openai','gpt-4o-mini',$3,false)",
      [a, u, encrypt(`p15-dummy-ai-${tag}`)]);
    ids.ai_knowledge_documents = await insert(client, "INSERT INTO ai_knowledge_documents(account_id,created_by,title,content) VALUES($1,$2,'Doc','Synthetic knowledge')",
      [a, u]);
    ids.ai_knowledge_chunks = await insert(client, "INSERT INTO ai_knowledge_chunks(account_id,document_id,content) VALUES($1,$2,'Synthetic knowledge')",
      [a, ids.ai_knowledge_documents]);
    ids.ai_usage_log = await insert(client, "INSERT INTO ai_usage_log(account_id,conversation_id,mode,provider,model) VALUES($1,$2,'auto_reply','openai','gpt-4o-mini')",
      [a, ids.conversations]);
    ids.quick_replies = await insert(client, "INSERT INTO quick_replies(account_id,user_id,title,content_text) VALUES($1,$2,'QR','Thanks')", [a, u]);
    ids.orders = await insert(client, "INSERT INTO orders(account_id,source,contact_id,conversation_id,whatsapp_config_id,currency,subtotal_minor,total_minor) VALUES($1,'manual',$2,$3,$4,'INR',1000,1000)",
      [a, ids.contacts, ids.conversations, ids.whatsapp_config]);
    const service = await insert(client, "INSERT INTO appointment_services(account_id,name,mode,duration_minutes) VALUES($1,'Consult','offline',30)", [a]);
    const location = await insert(client, "INSERT INTO appointment_locations(account_id,name,timezone) VALUES($1,'Office','Asia/Kolkata')", [a]);
    ids.appointment_services = service;
    ids.appointment_locations = location;
    ids.appointments = await insert(client, "INSERT INTO appointments(account_id,contact_id,service_id,location_id,start_at,end_at,timezone,status,source,service_name) VALUES($1,$2,$3,$4,date_trunc('hour',NOW())+interval '3 days',date_trunc('hour',NOW())+interval '3 days 30 minutes','Asia/Kolkata','confirmed','staff','Consult')",
      [a, ids.contacts, service, location]);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    // Users are created before the account inside the same transaction, so nothing remains.
    throw error;
  } finally {
    client.release();
  }
  return {
    accountId, context: users.owner.context, users,
    whatsappConfigId: ids.whatsapp_config, contactId: ids.contacts, conversationId: ids.conversations,
    messageId: ids.messages, orderId: ids.orders, appointmentId: ids.appointments, broadcastId: ids.broadcasts,
    webhookEndpointId: ids.webhook_endpoints, apiKeyId: ids.api_keys, apiKey: key.plaintext, ids,
  };
}

const created = new Map<string, string[]>();

/** Builds workspaces A and B (and optionally a noise workspace) as owner; fixture setup only. */
export async function createTenantPair(options: CreateTenantPairOptions = {}): Promise<TenantPair & { noise?: TenantFixture }> {
  connectFixtureDatabases();
  await ensureFixtureAuthEnv();
  const label = (options.label ?? "p15").replace(/[^a-z0-9-]/gi, "").toLowerCase() || "p15";
  const a = await createWorkspace(label, "a");
  created.set(a.accountId, Object.values(a.users).map((user) => user.userId));
  const b = await createWorkspace(label, "b");
  created.set(b.accountId, Object.values(b.users).map((user) => user.userId));
  if (!options.noise) return { a, b };
  const noise = await createWorkspace(label, "noise");
  created.set(noise.accountId, Object.values(noise.users).map((user) => user.userId));
  return { a, b, noise };
}

export type SignedRequestOptions = {
  /** Extra headers; defaults set cookie/Authorization, same-origin Origin and x-csrf-token. */
  headers?: Record<string, string>;
  /** Omit the CSRF header or send a wrong Origin, for negative cases. */
  omitCsrf?: boolean;
  origin?: string;
};

const sessions = new Map<string, Promise<{ accessToken: string; csrfToken: string }>>();

/** One real auth session per fixture user, created through the auth service (issueSession). */
function sessionFor(user: FixtureUser): Promise<{ accessToken: string; csrfToken: string }> {
  const key = `${user.userId}:${user.context.accountId}`;
  let session = sessions.get(key);
  if (!session) {
    session = (async () => {
      await ensureFixtureAuthEnv();
      const { issueSession } = await import("@/lib/auth/service");
      const issued = await issueSession(user.userId, { method: "password", accountId: user.context.accountId });
      return { accessToken: issued.accessToken, csrfToken: issued.csrfToken };
    })();
    session.catch(() => sessions.delete(key));
    sessions.set(key, session);
  }
  return session;
}

/**
 * A Request authenticated like the browser: a live auth_sessions row created through the auth
 * service, a token signed with in-process test keys, same-origin Origin and the CSRF header that
 * src/lib/auth/csrf.ts expects. A relative url resolves against APP_URL.
 */
export async function signedRequest(user: FixtureUser, method: string, url: string, body?: unknown,
  options: SignedRequestOptions = {}): Promise<Request> {
  const { accessToken, csrfToken } = await sessionFor(user);
  const { cookieNames } = await import("@/lib/auth/cookies");
  const origin = process.env.APP_URL ?? FIXTURE_ORIGIN;
  const headers: Record<string, string> = {
    cookie: `${cookieNames().access}=${encodeURIComponent(accessToken)}`,
    origin: options.origin ?? new URL(origin).origin,
    "sec-fetch-site": "same-origin",
    ...(options.omitCsrf ? {} : { "x-csrf-token": csrfToken }),
    ...(body !== undefined ? { "content-type": "application/json" } : {}),
    ...options.headers,
  };
  return new Request(new URL(url, origin), {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

/** A Request for /api/v1/* carrying the plain API key. A relative url resolves against APP_URL. */
export function apiKeyRequest(key: string, method: string, url: string, body?: unknown,
  headers: Record<string, string> = {}): Request {
  return new Request(new URL(url, process.env.APP_URL ?? FIXTURE_ORIGIN), {
    method,
    headers: {
      authorization: `Bearer ${key}`,
      ...(body !== undefined ? { "content-type": "application/json" } : {}),
      ...headers,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

/** Removes everything createTenantPair made, mirroring the existing afterAll cleanups. */
export async function cleanupTenants(accountIds: string[]): Promise<void> {
  if (!accountIds.length) return;
  const pool = fixtureOwnerPool();
  const userIds = accountIds.flatMap((id) => created.get(id) ?? []);
  // Account deletion cascades to every tenant-owned row; users go after their memberships.
  await pool.query("DELETE FROM accounts WHERE id = ANY($1::uuid[])", [accountIds]);
  if (userIds.length) {
    await pool.query("DELETE FROM auth_sessions WHERE user_id = ANY($1::uuid[])", [userIds]);
    await pool.query("DELETE FROM auth_users WHERE id = ANY($1::uuid[])", [userIds]);
  }
  for (const id of accountIds) created.delete(id);
  for (const key of [...sessions.keys()]) if (userIds.some((user) => key.startsWith(user))) sessions.delete(key);
}

/** Closes the fixture's owner pool (call after cleanupTenants in afterAll). */
export async function closeFixture(): Promise<void> {
  await ownerPool?.end();
  ownerPool = null;
}
