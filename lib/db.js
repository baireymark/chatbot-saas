import pg from 'pg';
import crypto from 'node:crypto';

// Supabase requires SSL. Set DATABASE_SSL=false only for a local Postgres.
// Keep the pool small: every serverless instance has its own pool.
const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  max: Number(process.env.PG_POOL_MAX || 2),
  idleTimeoutMillis: 10_000,
  ssl: process.env.DATABASE_SSL === 'false' ? false : { rejectUnauthorized: false },
});

const q = (text, params) => pool.query(text, params);
const one = async (text, params) => (await q(text, params)).rows[0];
const many = async (text, params) => (await q(text, params)).rows;

async function tx(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

export const closePool = () => pool.end();
export const isUniqueViolation = (err) => err?.code === '23505';
export const SESSION_TTL_MS = 7 * 24 * 3600 * 1000;

const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');
const newKey = (prefix) => prefix + crypto.randomBytes(24).toString('hex');
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ---------- passwords and sessions ----------

export function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  return `scrypt$${salt}$${crypto.scryptSync(password, salt, 64).toString('hex')}`;
}

export function verifyPassword(password, stored) {
  const [scheme, salt, hex] = String(stored).split('$');
  if (scheme !== 'scrypt' || !salt || !hex) return false;
  const expected = Buffer.from(hex, 'hex');
  const actual = crypto.scryptSync(password, salt, expected.length);
  return crypto.timingSafeEqual(actual, expected);
}

export const findUserByEmail = (email) => one('select * from users where email = $1', [email]);

async function insertUser(client, tenantId, email, password) {
  await client.query('insert into users (tenant_id, email, password_hash) values ($1, $2, $3)',
    [tenantId, email.toLowerCase(), hashPassword(password)]);
}

export const addUser = (tenantId, email, password) => insertUser(pool, tenantId, email, password);

export async function createSession(userId) {
  await q('delete from sessions where expires_at < now()');
  const token = crypto.randomBytes(32).toString('base64url');
  await q('insert into sessions (token_hash, user_id, expires_at) values ($1, $2, $3)',
    [sha256(token), userId, new Date(Date.now() + SESSION_TTL_MS)]);
  return token;
}

export const getSession = (token) => one(`
  select u.email, u.tenant_id, s.expires_at
  from sessions s join users u on u.id = s.user_id
  where s.token_hash = $1 and s.expires_at > now()`, [sha256(token)]);

export const deleteSession = (token) => q('delete from sessions where token_hash = $1', [sha256(token)]);

// ---------- rate limiting (shared across serverless instances) ----------

export async function rateHit(key, windowSeconds) {
  const row = await one(`
    insert into rate_limits (key, window_start, hits) values ($1, now(), 1)
    on conflict (key) do update set
      window_start = case when rate_limits.window_start < now() - make_interval(secs => $2)
                          then now() else rate_limits.window_start end,
      hits = case when rate_limits.window_start < now() - make_interval(secs => $2)
                  then 1 else rate_limits.hits + 1 end
    returning hits`, [key, windowSeconds]);
  if (Math.random() < 0.01) {
    await q("delete from rate_limits where window_start < now() - interval '1 day'");
  }
  return row.hits;
}

// ---------- tenants ----------

export async function createTenant({ name, origins, system_prompt, greeting, color, lead_webhook, owner }) {
  const publicKey = newKey('pk_');
  const secretKey = newKey('sk_');
  const id = await tx(async (c) => {
    const { rows: [t] } = await c.query(
      `insert into tenants (name, public_key, secret_hash, system_prompt, greeting, color, lead_webhook)
       values ($1, $2, $3, $4, $5, $6, $7) returning id`,
      [name, publicKey, sha256(secretKey), system_prompt || '',
        greeting || 'Hi! How can I help you today?', color || '#2563eb', lead_webhook || null]);
    for (const o of origins) {
      await c.query('insert into tenant_origins (origin, tenant_id) values ($1, $2) on conflict do nothing', [o, t.id]);
    }
    if (owner) await insertUser(c, t.id, owner.email, owner.password);
    return t.id;
  });
  // The secret is returned once. Only its hash is stored.
  return { id, public_key: publicKey, secret_key: secretKey };
}

export const getTenantById = (id) =>
  typeof id === 'string' && UUID_RE.test(id) ? one('select * from tenants where id = $1', [id]) : undefined;

export const getTenantByPublicKey = (key) =>
  one('select * from tenants where public_key = $1', [key]);

export const getTenantBySecret = (secret) =>
  one('select * from tenants where secret_hash = $1', [sha256(secret)]);

export const isKnownOrigin = async (origin) =>
  !!(await one('select 1 from tenant_origins where origin = $1 limit 1', [origin]));

export const isOriginAllowed = async (tenantId, origin) =>
  !!(await one('select 1 from tenant_origins where tenant_id = $1 and origin = $2', [tenantId, origin]));

// True if the origin is registered to a different tenant.
export const originOwnedByOther = async (origin, tenantId) =>
  !!(await one('select 1 from tenant_origins where origin = $1 and tenant_id <> $2', [origin, tenantId]));

export async function getOrigins(tenantId) {
  const rows = await many('select origin from tenant_origins where tenant_id = $1 order by origin', [tenantId]);
  return rows.map((r) => r.origin);
}

export function updateTenant(tenantId, { name, system_prompt, greeting, color, lead_webhook, origins }) {
  return tx(async (c) => {
    await c.query(`update tenants set name = $1, system_prompt = $2, greeting = $3, color = $4, lead_webhook = $5
                   where id = $6`, [name, system_prompt, greeting, color, lead_webhook, tenantId]);
    if (origins) {
      await c.query('delete from tenant_origins where tenant_id = $1', [tenantId]);
      for (const o of origins) {
        await c.query('insert into tenant_origins (origin, tenant_id) values ($1, $2)', [o, tenantId]);
      }
    }
  });
}

export async function rotateSecret(tenantId) {
  const secret = newKey('sk_');
  await q('update tenants set secret_hash = $1 where id = $2', [sha256(secret), tenantId]);
  return secret;
}

// ---------- knowledge base ----------

export function addDocument(tenantId, title, content, chunks) {
  return tx(async (c) => {
    const { rows: [d] } = await c.query(
      'insert into documents (tenant_id, title, content) values ($1, $2, $3) returning id',
      [tenantId, title, content]);
    if (chunks.length) {
      await c.query(
        'insert into chunks (tenant_id, document_id, text) select $1::uuid, $2::bigint, unnest($3::text[])',
        [tenantId, d.id, chunks]);
    }
    return Number(d.id);
  });
}

export async function deleteDocument(tenantId, docId) {
  const r = await q('delete from documents where id = $1 and tenant_id = $2', [docId, tenantId]);
  return r.rowCount > 0;
}

export const listDocuments = (tenantId) => many(`
  select d.id, d.title, d.created_at, length(d.content) as chars,
    (select count(*)::int from chunks c where c.document_id = d.id) as chunks
  from documents d where d.tenant_id = $1 order by d.id desc`, [tenantId]);

export const listChunks = (tenantId) =>
  many('select id, text from chunks where tenant_id = $1', [tenantId]);

// ---------- conversations, leads, stats ----------

// Most recent turns in chronological order. Always starts with a user message.
export async function getHistory(tenantId, conversationId, limit = 10) {
  const rows = await many(`
    select role, content from (
      select id, role, content from messages
      where tenant_id = $1 and conversation_id = $2
      order by id desc limit $3
    ) recent order by id asc`, [tenantId, conversationId, limit]);
  while (rows.length && rows[0].role !== 'user') rows.shift();
  return rows;
}

export const saveExchange = ({ tenantId, conversationId, userMessage, reply, needsHuman }) =>
  q(`insert into messages (tenant_id, conversation_id, role, content, needs_human) values
       ($1, $2, 'user', $3, false),
       ($1, $2, 'assistant', $4, $5)`,
    [tenantId, conversationId, userMessage, reply, !!needsHuman]);

export const listConversations = (tenantId, limit = 25, offset = 0) => many(`
  select m.conversation_id as id,
    min(m.created_at) as started_at,
    max(m.created_at) as last_at,
    count(*) filter (where m.role = 'user')::int as messages,
    count(*) filter (where m.needs_human)::int as handoffs,
    (select p.content from messages p
       where p.tenant_id = m.tenant_id and p.conversation_id = m.conversation_id and p.role = 'user'
       order by p.id limit 1) as preview
  from messages m
  where m.tenant_id = $1
  group by m.tenant_id, m.conversation_id
  order by last_at desc
  limit $2 offset $3`, [tenantId, limit, offset]);

export const getConversation = (tenantId, conversationId) => many(`
  select role, content, needs_human, created_at from messages
  where tenant_id = $1 and conversation_id = $2 order by id`, [tenantId, conversationId]);

export async function overviewStats(tenantId, days) {
  const interval = `${days} days`;
  const t = await one(`
    select
      count(distinct conversation_id) filter (where role = 'user')::int as conversations,
      count(*) filter (where role = 'user')::int as messages,
      count(*) filter (where role = 'assistant')::int as replies,
      count(*) filter (where role = 'assistant' and needs_human)::int as handoffs
    from messages where tenant_id = $1 and created_at >= now() - $2::interval`, [tenantId, interval]);
  const leads = (await one(`select count(*)::int as n from leads
    where tenant_id = $1 and created_at >= now() - $2::interval`, [tenantId, interval])).n;
  const daily = await many(`
    select (created_at at time zone 'utc')::date::text as day,
      count(distinct conversation_id)::int as conversations
    from messages
    where tenant_id = $1 and role = 'user' and created_at >= now() - $2::interval
    group by 1 order by 1`, [tenantId, interval]);
  const replies = t.replies;
  const handoffs = t.handoffs;
  return {
    days,
    conversations: t.conversations,
    messages: t.messages,
    replies,
    handoffs,
    handoff_rate: replies ? handoffs / replies : 0,
    leads,
    daily,
  };
}

export const saveLead = (tenantId, lead) =>
  q('insert into leads (tenant_id, conversation_id, name, email, message) values ($1, $2, $3, $4, $5)',
    [tenantId, lead.conversation_id, lead.name, lead.email, lead.message]);

export const listLeads = (tenantId, limit = 500) => many(`
  select id, conversation_id, name, email, message, created_at from leads
  where tenant_id = $1 order by id desc limit $2`, [tenantId, limit]);
