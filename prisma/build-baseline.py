"""Reviewable schema inventory extraction from the immutable upstream reference.

This script only writes local baseline/schema artifacts. It never connects to a DB.
Migration-time platform functions/policies are deliberately not replayed.
"""
import json
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SOURCE = ROOT / '.reference/wacrm/supabase/migrations'

def split_top(text):
    parts, start, depth, quoted = [], 0, 0, False
    for i, c in enumerate(text):
        if c == "'": quoted = not quoted
        if not quoted:
            if c == '(': depth += 1
            if c == ')': depth -= 1
            if c == ',' and depth == 0:
                parts.append(text[start:i].strip()); start = i + 1
    parts.append(text[start:].strip())
    return parts

tables = {}
sources = []
for path in sorted(SOURCE.glob('*.sql')):
    sources.append(path.name)
    text = re.sub(r'--[^\n]*', '', path.read_text(encoding='utf8'))
    for match in re.finditer(r'CREATE TABLE IF NOT EXISTS (\w+)\s*\((.*?)\);', text, re.S | re.I):
        tables[match[1]] = split_top(match[2])
    for match in re.finditer(r'ALTER TABLE (\w+)\s+(.*?);', text, re.S | re.I):
        if match[1] not in tables: continue
        for item in split_top(match[2]):
            add = re.match(r'ADD COLUMN IF NOT EXISTS\s+(.*)', item, re.S | re.I)
            if add: tables[match[1]].append(add[1].strip())

upstream_names = list(tables)

def replace(table, column, definition):
    for i, item in enumerate(tables[table]):
        if item.split()[0] == column:
            tables[table][i] = definition
            return
    tables[table].append(definition)

def add_table(name, definition): tables[name] = split_top(definition)

replace('deals', 'contact_id', 'contact_id UUID REFERENCES contacts(id) ON DELETE SET NULL')
replace('broadcast_recipients', 'contact_id', 'contact_id UUID REFERENCES contacts(id) ON DELETE SET NULL')
replace('deals', 'status', "status TEXT DEFAULT 'open' CHECK (status IN ('open','won','lost'))")
replace('message_templates', 'status', "status TEXT DEFAULT 'DRAFT' CHECK (status IN ('DRAFT','PENDING','APPROVED','REJECTED','PAUSED','DISABLED','IN_APPEAL','PENDING_DELETION'))")
replace('message_templates', 'quality_score', "quality_score TEXT CHECK (quality_score IS NULL OR quality_score IN ('GREEN','YELLOW','RED'))")
replace('messages', 'content_type', "content_type TEXT NOT NULL DEFAULT 'text' CHECK (content_type IN ('text','image','document','audio','video','location','template','interactive'))")
replace('flow_nodes', 'node_type', "node_type TEXT NOT NULL CHECK (node_type IN ('start','send_buttons','send_list','send_message','send_media','collect_input','condition','set_tag','handoff','http_fetch','end'))")
replace('automation_pending_executions', 'status', "status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','running','done','failed','awaiting_reply','expired','superseded'))")
for table in ['ai_configs', 'ai_usage_log']:
    replace(table, 'provider', "provider TEXT NOT NULL CHECK (provider IN ('openai','anthropic','openai_compatible'))")
tables['ai_configs'].append("CHECK (provider <> 'openai_compatible' OR (base_url IS NOT NULL AND btrim(base_url) <> ''))")
tables['message_templates'].append("CHECK (buttons IS NULL OR (jsonb_typeof(buttons) = 'array' AND jsonb_array_length(buttons) <= 10))")
replace('accounts', 'default_currency', "default_currency TEXT NOT NULL DEFAULT 'USD' CHECK (default_currency ~ '^[A-Z]{3}$')")
replace('profiles', 'account_id', 'account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE')
replace('profiles', 'account_role', "account_role TEXT NOT NULL CHECK (account_role IN ('owner','admin','agent','viewer'))")
# A user may have multiple organization presences after membership migration.
replace('member_presence', 'user_id', 'user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE')
tables['member_presence'].append('PRIMARY KEY (account_id, user_id)')
# Domain tenant keys include children so relational integrity cannot cross tenants.
for table in upstream_names:
    if table == 'accounts': continue
    replace(table, 'account_id', "account_id UUID NOT NULL DEFAULT NULLIF(current_setting('app.account_id', true),'')::uuid REFERENCES accounts(id) ON DELETE CASCADE")
tables['whatsapp_config'] = [x for x in tables['whatsapp_config'] if x.upper().replace(' ', '') != 'UNIQUE(USER_ID)']
tables['whatsapp_config'].append('UNIQUE (account_id)')
replace('whatsapp_config','verify_token_hash','verify_token_hash TEXT CHECK (verify_token_hash IS NULL OR verify_token_hash ~ \'^[0-9a-f]{64}$\')')

add_table('auth_users', '''id UUID PRIMARY KEY DEFAULT gen_random_uuid(), email TEXT NOT NULL UNIQUE,
full_name TEXT NOT NULL, password_hash TEXT NOT NULL, email_verified_at TIMESTAMPTZ,
disabled_at TIMESTAMPTZ, created_at TIMESTAMPTZ NOT NULL DEFAULT now()''')
add_table('auth_sessions', '''id UUID PRIMARY KEY DEFAULT gen_random_uuid(), user_id UUID NOT NULL REFERENCES auth_users(id) ON DELETE CASCADE,
account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE, csrf_hash TEXT NOT NULL,
expires_at TIMESTAMPTZ NOT NULL, revoked_at TIMESTAMPTZ, mfa_verified_at TIMESTAMPTZ,
created_at TIMESTAMPTZ NOT NULL DEFAULT now()''')
add_table('auth_refresh_tokens', '''id UUID PRIMARY KEY DEFAULT gen_random_uuid(), session_id UUID NOT NULL REFERENCES auth_sessions(id) ON DELETE CASCADE,
token_hash TEXT NOT NULL UNIQUE, expires_at TIMESTAMPTZ NOT NULL, consumed_at TIMESTAMPTZ,
replacement_id UUID REFERENCES auth_refresh_tokens(id) ON DELETE SET NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT now()''')
add_table('auth_verifications', '''id UUID PRIMARY KEY DEFAULT gen_random_uuid(), user_id UUID NOT NULL REFERENCES auth_users(id) ON DELETE CASCADE,
purpose TEXT NOT NULL CHECK (purpose IN ('verify','reset')), token_hash TEXT NOT NULL UNIQUE,
expires_at TIMESTAMPTZ NOT NULL, consumed_at TIMESTAMPTZ''')
add_table('account_memberships', '''id UUID PRIMARY KEY DEFAULT gen_random_uuid(), account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
user_id UUID NOT NULL REFERENCES auth_users(id) ON DELETE CASCADE, role TEXT NOT NULL CHECK (role IN ('owner','admin','agent','viewer')),
created_at TIMESTAMPTZ NOT NULL DEFAULT now(), UNIQUE (account_id,user_id)''')
add_table('auth_rate_limits', '''key TEXT PRIMARY KEY, attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0), reset_at TIMESTAMPTZ NOT NULL''')
add_table('auth_mfa_factors', '''id UUID PRIMARY KEY DEFAULT gen_random_uuid(), user_id UUID NOT NULL UNIQUE REFERENCES auth_users(id) ON DELETE CASCADE,
secret_encrypted TEXT NOT NULL, verified_at TIMESTAMPTZ, last_used_step BIGINT, recovery_hashes TEXT[] NOT NULL DEFAULT '{}',
created_at TIMESTAMPTZ NOT NULL DEFAULT now()''')
add_table('jobs', '''id UUID PRIMARY KEY DEFAULT gen_random_uuid(), type TEXT NOT NULL, tenant_id UUID REFERENCES accounts(id) ON DELETE CASCADE,
payload JSONB NOT NULL DEFAULT '{}', dedupe_key TEXT UNIQUE, status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','running','done','failed')),
run_at TIMESTAMPTZ NOT NULL DEFAULT now(), lease_until TIMESTAMPTZ, attempts INTEGER NOT NULL DEFAULT 0,
max_attempts INTEGER NOT NULL DEFAULT 5 CHECK (max_attempts > 0), last_error TEXT,
created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now()''')
add_table('webhook_receipts', '''id UUID PRIMARY KEY DEFAULT gen_random_uuid(), provider TEXT NOT NULL, dedupe_key TEXT NOT NULL UNIQUE,
payload JSONB NOT NULL, status TEXT NOT NULL DEFAULT 'pending', created_at TIMESTAMPTZ NOT NULL DEFAULT now()''')
add_table('outbox_events', '''id UUID PRIMARY KEY DEFAULT gen_random_uuid(), account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
recipient_user_id UUID REFERENCES auth_users(id) ON DELETE CASCADE, event_type TEXT NOT NULL, payload JSONB NOT NULL DEFAULT '{}',
created_at TIMESTAMPTZ NOT NULL DEFAULT now()''')
add_table('outbound_intents', '''id UUID PRIMARY KEY DEFAULT gen_random_uuid(), account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
conversation_id UUID REFERENCES conversations(id) ON DELETE SET NULL, provider_message_id TEXT, idempotency_key TEXT NOT NULL UNIQUE,
status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','dispatching','accepted','unknown','failed')),
created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now(), last_error TEXT''')
add_table('audit_logs', '''id UUID PRIMARY KEY DEFAULT gen_random_uuid(), account_id UUID REFERENCES accounts(id) ON DELETE SET NULL,
user_id UUID REFERENCES auth_users(id) ON DELETE SET NULL, action TEXT NOT NULL, resource_id TEXT,
metadata JSONB NOT NULL DEFAULT '{}', created_at TIMESTAMPTZ NOT NULL DEFAULT now()''')
add_table('media_objects', '''id UUID PRIMARY KEY DEFAULT gen_random_uuid(), account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
uploaded_by UUID REFERENCES auth_users(id) ON DELETE SET NULL, object_key TEXT NOT NULL, bucket TEXT NOT NULL,
content_type TEXT NOT NULL, byte_size BIGINT NOT NULL CHECK (byte_size >= 0), original_name TEXT,
conversation_id UUID REFERENCES conversations(id) ON DELETE SET NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT now(), deleted_at TIMESTAMPTZ,
UNIQUE(account_id,bucket,object_key)''')

sql = ['-- Bodhinox Chat reviewed PostgreSQL baseline. Source: 46 upstream migrations.',
       '-- Tenant child keys and identity boundaries are deliberate foundation additions.',
       'CREATE EXTENSION IF NOT EXISTS pgcrypto;', 'CREATE EXTENSION IF NOT EXISTS vector;']
references, inventory = [], {}
for name, definitions in tables.items():
    clean, fields = [], []
    for definition in definitions:
        definition = re.sub(r'\baccount_role_enum\b', 'TEXT', definition)
        definition = definition.replace('uuid_generate_v4()', 'gen_random_uuid()')
        definition = definition.replace('auth.users', 'auth_users')
        match = re.search(r'REFERENCES ([\w.]+)\s*\((\w+)\)(?:\s+ON DELETE (CASCADE|RESTRICT|SET NULL))?', definition, re.I)
        reference = None
        if match:
            reference = {'table': match[1], 'column': match[2], 'onDelete': match[3] or 'NO ACTION'}
            references.append((name, definition.split()[0], reference))
            definition = definition[:match.start()] + definition[match.end():]
        clean.append(definition.strip())
        match = re.match(r'(\w+)\s+(UUID|TEXT\[\]|TEXT|INTEGER|BIGINT|BOOLEAN|TIMESTAMPTZ|DATE|JSONB|NUMERIC\(\d+,\d+\)|tsvector|vector\(1536\))(.*)', definition, re.I | re.S)
        if match:
            fields.append({'name': match[1], 'type': match[2].lower(), 'nullable': not bool(re.search(r'NOT NULL|PRIMARY KEY|GENERATED', match[3], re.I)), 'default': (re.search(r'DEFAULT\s+(.+?)(?:\s+(?:CHECK|UNIQUE|NOT NULL)|$)', match[3], re.I | re.S) or [None,None])[1], 'reference': reference, 'definition': definition})
    if any(f['name'] == 'account_id' for f in fields) and any(f['name'] == 'id' for f in fields):
        clean.append('UNIQUE (account_id, id)')
    inventory[name] = fields
    sql.append(f'CREATE TABLE {name} (\n  ' + ',\n  '.join(clean) + '\n);')

for table, col, ref in references:
    parent, target, action = ref['table'], ref['column'], ref['onDelete']
    composite = col != 'account_id' and parent != 'profiles' and any(f['name']=='account_id' for f in inventory[table]) and any(f['name']=='account_id' for f in inventory.get(parent,[])) and target == 'id'
    columns = f'account_id, {col}' if composite else col
    targets = f'account_id, {target}' if composite else target
    deletion = f'ON DELETE {action}' + (f' ({col})' if composite and action == 'SET NULL' else '')
    sql.append(f'ALTER TABLE {table} ADD CONSTRAINT {table}_{col}_fkey FOREIGN KEY ({columns}) REFERENCES {parent} ({targets}) {deletion};')

for table, col in [('conversations','assigned_agent_id'), ('ai_configs','handoff_agent_id')]:
    # Keep audit user references, and additionally require active membership for assignment.
    sql.append(f'ALTER TABLE {table} ADD CONSTRAINT {table}_{col}_membership_fkey FOREIGN KEY (account_id, {col}) REFERENCES account_memberships (account_id, user_id) ON DELETE SET NULL ({col});')

# Carefully selected final functions retain concurrency behavior; invoker security
# replaces the platform's implicit privileged role, so caller RLS always applies.
retained_functions = []
for file in ['005_broadcast_counts_incremental.sql', '025_filter_contacts_by_tags.sql']:
    text = re.sub(r'--[^\n]*','',(SOURCE/file).read_text(encoding='utf8'))
    for match in re.finditer(r'CREATE OR REPLACE FUNCTION.*?\$\$.*?\$\$.*?;',text,re.S|re.I):
        fn = match[0].replace('SECURITY DEFINER','SECURITY INVOKER')
        # Internal dynamic updates may alter only the known aggregate columns.
        if '_bcast_bump(' in fn and 'RETURNS VOID' in fn:
            fn = fn.replace('BEGIN', "BEGIN\n  IF col NOT IN ('sent_count','delivered_count','read_count','replied_count','failed_count') THEN RAISE EXCEPTION 'Invalid broadcast counter'; END IF;",1)
        retained_functions.append(fn)
suffix = retained_functions
suffix.append('CREATE TRIGGER broadcast_recipient_aggregate AFTER INSERT OR UPDATE OR DELETE ON broadcast_recipients FOR EACH ROW EXECUTE FUNCTION broadcast_recipient_aggregate_trigger();')
suffix.append('REVOKE ALL ON FUNCTION _bcast_bump(uuid,text,integer),_bcast_cols_for_status(text),broadcast_recipient_aggregate_trigger(),recompute_broadcast_counts(uuid),filter_contacts_by_tags(uuid[],text,integer,integer) FROM PUBLIC;')
suffix.append('GRANT EXECUTE ON FUNCTION _bcast_bump(uuid,text,integer),_bcast_cols_for_status(text),broadcast_recipient_aggregate_trigger(),recompute_broadcast_counts(uuid),filter_contacts_by_tags(uuid[],text,integer,integer) TO bodhinox_app,bodhinox_worker;')

output = ROOT / 'prisma/migrations/20261014000000_foundation'
output.mkdir(parents=True, exist_ok=True)
baseline_sql = '\n\n'.join(sql)+'\n\n'+(ROOT/'prisma/baseline-extras.sql').read_text(encoding='utf8')+'\n\n'+'\n\n'.join(suffix)+'\n'
baseline_path = output/'migration.sql'
if baseline_path.exists() and baseline_path.read_text(encoding='utf8') != baseline_sql:
    raise RuntimeError('The baseline has been applied and is immutable. Write changes in a new migration.')
baseline_path.write_text(baseline_sql, encoding='utf8')
# Follow-up migrations evolve only the latest ORM/inventory mapping, never the baseline.
for table, name, sql_type, default in [('jobs','lease_token','uuid',None),('outbound_intents','result','jsonb',None),('auth_verifications','metadata','jsonb',"'{}'"),('conversations','bot_paused','boolean','false'),('contacts','inbound_created_meta_id','text',None),('conversations','inbound_created_meta_id','text',None)]:
    definition = name+' '+sql_type.upper()+(' NOT NULL DEFAULT '+default if default else '')
    tables[table].append(definition)
    inventory[table].append({'name':name,'type':sql_type,'nullable':not bool(default),'default':default,'reference':None,'definition':definition})
for field in inventory['auth_verifications']:
    if field['name']=='purpose': field['definition']=field['definition'].replace("('verify','reset')","('verify','reset','change_email')")
inbound_fields = [
    ('id','uuid',False,'gen_random_uuid()','id UUID PRIMARY KEY DEFAULT gen_random_uuid()'),
    ('account_id','uuid',False,None,'account_id UUID NOT NULL'),
    ('message_id','uuid',False,None,'message_id UUID NOT NULL'),
    ('stage','text',False,None,'stage TEXT NOT NULL'),
    ('status','text',False,"'dispatching'","status TEXT NOT NULL DEFAULT 'dispatching'"),
    ('context','jsonb',False,"'{}'","context JSONB NOT NULL DEFAULT '{}'"),
    ('last_error','text',True,None,'last_error TEXT'),
    ('created_at','timestamptz',False,'now()','created_at TIMESTAMPTZ NOT NULL DEFAULT now()'),
    ('updated_at','timestamptz',False,'now()','updated_at TIMESTAMPTZ NOT NULL DEFAULT now()'),
]
inventory['inbound_action_steps'] = [{'name':name,'type':kind,'nullable':nullable,'default':default,'reference':None,'definition':definition} for name,kind,nullable,default,definition in inbound_fields]
tables['inbound_action_steps'] = [definition for _,_,_,_,definition in inbound_fields]+['UNIQUE(account_id,message_id,stage)']
(ROOT/'prisma/schema-inventory.json').write_text(json.dumps({'upstreamMigrations':sources,'upstreamTables':upstream_names,'tables':inventory},indent=2)+'\n',encoding='utf8')

schema = ['// Scalar ORM mapping; reviewed SQL owns composite FKs, RLS, triggers and generated columns.',
'generator client {\n  provider = "prisma-client-js"\n}\n', 'datasource db {\n  provider = "postgresql"\n}\n']
type_map = {'uuid':('String','@db.Uuid'), 'text':('String',''), 'text[]':('String[]',''), 'integer':('Int',''), 'bigint':('BigInt',''), 'boolean':('Boolean',''), 'timestamptz':('DateTime','@db.Timestamptz(6)'), 'date':('DateTime','@db.Date'), 'jsonb':('Json','@db.JsonB'), 'tsvector':('Unsupported("tsvector")',''), 'vector(1536)':('Unsupported("vector(1536)")','')}
for name, fields in inventory.items():
    model = [f'model {name} {{']
    for field in fields:
        typ, native = type_map.get(field['type'],('Decimal','@db.Decimal(12, 2)'))
        if field['nullable'] and not typ.endswith('[]'): typ += '?'
        attrs = native
        if 'PRIMARY KEY' in field['definition'].upper() and name != 'member_presence': attrs += ' @id'
        if re.search(r'\bUNIQUE\b', field['definition'], re.I): attrs += ' @unique'
        default = field['default']
        if default and field['name'] not in ('fts','phone_normalized'):
            if re.fullmatch(r'gen_random_uuid\(\)', default,re.I): attrs += ' @default(dbgenerated("gen_random_uuid()"))'
            elif re.fullmatch(r'now\(\)',default,re.I): attrs += ' @default(now())'
            elif default.lower() in ('true','false') or re.fullmatch(r'-?\d+',default): attrs += f' @default({default.lower()})'
            elif default.startswith("'") and default.endswith("'"):
                attrs += ' @default([])' if typ.endswith('[]') else f' @default({json.dumps(default[1:-1])})'
            else: attrs += f' @default(dbgenerated({json.dumps(default)}))'
        if field['name'] in ('fts','phone_normalized'): attrs += ' @default(dbgenerated())'
        model.append(f'  {field["name"]} {typ} {attrs}'.rstrip())
    if name == 'member_presence': model.append('  @@id([account_id, user_id])')
    for definition in tables[name]:
        match = re.match(r'UNIQUE\s*\(([^)]+)\)', definition,re.I)
        if match: model.append('  @@unique(['+', '.join(x.strip() for x in match[1].split(','))+'])')
    if name != 'inbound_action_steps' and any(f['name']=='account_id' for f in fields) and any(f['name']=='id' for f in fields): model.append('  @@unique([account_id, id])')
    model.append('}')
    schema.append('\n'.join(model))
(ROOT/'prisma/schema.prisma').write_text('\n\n'.join(schema)+'\n',encoding='utf8')
print(f'Extracted {len(sources)} migrations, {len(upstream_names)} upstream tables and {len(tables)} total tables.')
