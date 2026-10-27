import express from 'express';
import cors from 'cors';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as store from './lib/db.js';
import { chunkText, searchChunks } from './lib/retrieval.js';
import { answer } from './lib/llm.js';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const app = express();
app.set('trust proxy', 1);
app.use(express.json({ limit: '200kb' }));

// Local development only. On Vercel, these files are served from the CDN before the function runs.
app.use('/dashboard', express.static(path.join(ROOT, 'dashboard'), { maxAge: '5m' }));
app.get('/widget.js', (_req, res) => res.sendFile(path.join(ROOT, 'widget.js')));
app.get('/', (_req, res) => res.redirect('/dashboard/'));

// CORS: only sites registered to some client may call the widget API from a browser.
// Credentials are not allowed, so other websites can never send dashboard cookies.
app.use(cors({
  origin: (origin, cb) => {
    if (!origin) return cb(null, true);
    store.isKnownOrigin(origin).then((ok) => cb(null, ok), (err) => cb(err));
  },
  allowedHeaders: ['Content-Type', 'x-public-key', 'x-admin-key', 'Authorization'],
}));

// Wrap async handlers so rejected promises reach the error handler.
const ah = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

// Database-backed rate limit, so the count is shared across serverless instances.
const rateLimit = (name, limit, windowSeconds) => ah(async (req, res, next) => {
  const hits = await store.rateHit(`${name}:${req.ip}`, windowSeconds);
  if (hits > limit) {
    return res.status(429).json({ error: 'Too many requests. Please wait a moment and try again.' });
  }
  next();
});
const chatLimiter = rateLimit('chat', 20, 60);
const leadLimiter = rateLimit('lead', 10, 60);
const loginLimiter = rateLimit('login', 10, 900);

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const clip = (v, n) => (typeof v === 'string' ? v.slice(0, n).trim() : null);
const safeEqual = (a, b) => {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && crypto.timingSafeEqual(x, y);
};

const COOKIE = 'sid';
const isProd = process.env.NODE_ENV === 'production';
const cookieAttrs = (maxAge) => `Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${isProd ? '; Secure' : ''}`;
function parseCookie(header, name) {
  for (const part of (header || '').split(';')) {
    const [k, ...rest] = part.trim().split('=');
    if (k === name) return rest.join('=');
  }
  return null;
}

function validateCredentials(emailRaw, password) {
  const email = clip(emailRaw, 200)?.toLowerCase();
  if (!email || !EMAIL_RE.test(email)) return null;
  if (typeof password !== 'string' || password.length < 10 || password.length > 200) return null;
  return { email, password };
}

function requireAdmin(req, res, next) {
  const expected = process.env.ADMIN_KEY || '';
  if (!expected || !safeEqual(req.get('x-admin-key') || '', expected)) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  next();
}

// Client API: secret key in the Authorization header.
const requireSecret = ah(async (req, res, next) => {
  const m = /^Bearer (sk_[A-Za-z0-9]+)$/.exec(req.get('authorization') || '');
  const tenant = m ? await store.getTenantBySecret(m[1]) : null;
  if (!tenant) return res.status(401).json({ error: 'unauthorized' });
  req.tenant = tenant;
  next();
});

// Widget API: public key, and the browser origin must be registered to that client.
async function widgetTenant(req, res) {
  const tenant = await store.getTenantByPublicKey(req.get('x-public-key') || '');
  if (!tenant) {
    res.status(401).json({ error: 'invalid public key' });
    return null;
  }
  const origin = req.get('origin');
  if (origin && !(await store.isOriginAllowed(tenant.id, origin))) {
    res.status(403).json({ error: 'origin not allowed' });
    return null;
  }
  return tenant;
}

// Dashboard: session cookie. Write routes accept only JSON bodies, which blocks cross-site
// form posts; SameSite=Lax also keeps the cookie off cross-site requests.
const requireUser = ah(async (req, res, next) => {
  const token = parseCookie(req.get('cookie'), COOKIE);
  const session = token ? await store.getSession(token) : null;
  if (!session) return res.status(401).json({ error: 'Please sign in.' });
  req.user = session;
  req.tenantId = session.tenant_id;
  next();
});

async function ingestDocument(tenantId, body) {
  const title = clip(body?.title, 200);
  const content = typeof body?.content === 'string' ? body.content : '';
  if (!title || !content.trim()) return { status: 400, body: { error: 'Title and content are required.' } };
  if (content.length > 500_000) return { status: 413, body: { error: 'Document is too large (max 500,000 characters).' } };
  const chunks = chunkText(content);
  const id = await store.addDocument(tenantId, title, content, chunks);
  return { status: 201, body: { id, chunks: chunks.length } };
}

const iso = (v) => (v instanceof Date ? v.toISOString() : v);
const csvCell = (v) => {
  let s = v == null ? '' : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`; // stop spreadsheet formula injection
  return `"${s.replace(/"/g, '""')}"`;
};

app.get('/health', (_req, res) => res.json({ ok: true }));

// ---------- Admin (run by you) ----------

app.post('/admin/tenants', requireAdmin, ah(async (req, res) => {
  const b = req.body || {};
  const name = clip(b.name, 120);
  const origins = Array.isArray(b.origins) ? b.origins : [];
  if (!name || !origins.length) return res.status(400).json({ error: 'name and origins[] are required' });
  const owner = validateCredentials(b.owner_email, b.owner_password);
  if (!owner) return res.status(400).json({ error: 'owner_email and an owner_password of 10+ characters are required' });

  let normalized;
  try {
    normalized = [...new Set(origins.map((o) => new URL(o).origin))];
  } catch {
    return res.status(400).json({ error: 'each origin must be a full URL, e.g. https://client.com' });
  }
  const taken = await Promise.all(normalized.map((o) => store.isKnownOrigin(o)));
  if (taken.some(Boolean)) {
    return res.status(409).json({ error: 'One of those websites is already registered to another account.' });
  }
  try {
    const created = await store.createTenant({
      name,
      origins: normalized,
      system_prompt: clip(b.system_prompt, 4000) || '',
      greeting: clip(b.greeting, 300),
      color: /^#[0-9a-f]{6}$/i.test(b.color || '') ? b.color : undefined,
      lead_webhook: typeof b.lead_webhook === 'string' && /^https:\/\/\S+$/.test(b.lead_webhook) ? b.lead_webhook : undefined,
      owner,
    });
    res.status(201).json(created);
  } catch (err) {
    if (store.isUniqueViolation(err)) return res.status(409).json({ error: 'That owner email is already in use.' });
    throw err;
  }
}));

app.post('/admin/users', requireAdmin, ah(async (req, res) => {
  const b = req.body || {};
  const tenant = await store.getTenantById(b.tenant_id);
  if (!tenant) return res.status(404).json({ error: 'tenant not found' });
  const cred = validateCredentials(b.email, b.password);
  if (!cred) return res.status(400).json({ error: 'A valid email and a password of 10+ characters are required' });
  try {
    await store.addUser(tenant.id, cred.email, cred.password);
  } catch (err) {
    if (store.isUniqueViolation(err)) return res.status(409).json({ error: 'That email is already in use.' });
    throw err;
  }
  res.status(201).json({ ok: true });
}));

// ---------- Auth (dashboard login) ----------

app.post('/auth/login', loginLimiter, ah(async (req, res) => {
  const email = clip(req.body?.email, 200)?.toLowerCase() || '';
  const password = typeof req.body?.password === 'string' ? req.body.password : '';
  const user = email ? await store.findUserByEmail(email) : null;
  if (!user || !store.verifyPassword(password, user.password_hash)) {
    return res.status(401).json({ error: 'Invalid email or password.' });
  }
  const token = await store.createSession(user.id);
  res.setHeader('Set-Cookie', `${COOKIE}=${token}; ${cookieAttrs(store.SESSION_TTL_MS / 1000)}`);
  res.json({ ok: true });
}));

app.post('/auth/logout', ah(async (req, res) => {
  const token = parseCookie(req.get('cookie'), COOKIE);
  if (token) await store.deleteSession(token);
  res.setHeader('Set-Cookie', `${COOKIE}=; ${cookieAttrs(0)}`);
  res.json({ ok: true });
}));

app.get('/auth/me', requireUser, ah(async (req, res) => {
  const tenant = await store.getTenantById(req.tenantId);
  res.json({ user: { email: req.user.email }, tenant: { id: tenant.id, name: tenant.name } });
}));

// ---------- Dashboard API (session required) ----------

const dash = express.Router();
dash.use(requireUser);

dash.get('/overview', ah(async (req, res) => {
  const days = [7, 30, 90].includes(Number(req.query.days)) ? Number(req.query.days) : 30;
  res.json(await store.overviewStats(req.tenantId, days));
}));

dash.get('/settings', ah(async (req, res) => {
  const t = await store.getTenantById(req.tenantId);
  res.json({
    name: t.name,
    system_prompt: t.system_prompt,
    greeting: t.greeting,
    color: t.color,
    lead_webhook: t.lead_webhook || '',
    origins: await store.getOrigins(t.id),
    public_key: t.public_key,
  });
}));

dash.put('/settings', ah(async (req, res) => {
  const b = req.body || {};
  const name = clip(b.name, 120);
  if (!name) return res.status(400).json({ error: 'Business name is required.' });
  if (!/^#[0-9a-f]{6}$/i.test(b.color || '')) return res.status(400).json({ error: 'Color must look like #2563eb.' });
  const webhook = typeof b.lead_webhook === 'string' ? b.lead_webhook.trim() : '';
  if (webhook && !/^https:\/\/\S+$/.test(webhook)) {
    return res.status(400).json({ error: 'The lead webhook must start with https://' });
  }
  const rawOrigins = Array.isArray(b.origins) ? b.origins.map((o) => String(o).trim()).filter(Boolean) : [];
  if (!rawOrigins.length) return res.status(400).json({ error: 'Add at least one website where the chatbot may run.' });

  let origins;
  try {
    origins = [...new Set(rawOrigins.map((o) => new URL(o).origin))];
  } catch {
    return res.status(400).json({ error: 'Each website must be a full URL, e.g. https://yoursite.com' });
  }
  const owned = await Promise.all(origins.map((o) => store.originOwnedByOther(o, req.tenantId)));
  if (owned.some(Boolean)) {
    return res.status(409).json({ error: 'One of those websites is already registered to another account.' });
  }

  await store.updateTenant(req.tenantId, {
    name,
    system_prompt: clip(b.system_prompt, 4000) || '',
    greeting: clip(b.greeting, 300) || 'Hi! How can I help you today?',
    color: b.color,
    lead_webhook: webhook || null,
    origins,
  });
  res.json({ ok: true });
}));

dash.post('/secret/rotate', ah(async (req, res) => {
  res.json({ secret_key: await store.rotateSecret(req.tenantId) });
}));

dash.get('/documents', ah(async (req, res) => {
  res.json(await store.listDocuments(req.tenantId));
}));

dash.post('/documents', ah(async (req, res) => {
  const r = await ingestDocument(req.tenantId, req.body);
  res.status(r.status).json(r.body);
}));

dash.delete('/documents/:id', ah(async (req, res) => {
  const id = Number(req.params.id);
  const ok = Number.isInteger(id) && (await store.deleteDocument(req.tenantId, id));
  res.status(ok ? 204 : 404).end();
}));

dash.get('/conversations', ah(async (req, res) => {
  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  const limit = 25;
  res.json({ page, items: await store.listConversations(req.tenantId, limit, (page - 1) * limit) });
}));

dash.get('/conversations/:id', ah(async (req, res) => {
  if (!/^[\w-]{8,64}$/.test(req.params.id)) return res.status(404).json({ error: 'Not found.' });
  const rows = await store.getConversation(req.tenantId, req.params.id);
  if (!rows.length) return res.status(404).json({ error: 'Not found.' });
  res.json({
    id: req.params.id,
    messages: rows.map((m) => ({ role: m.role, content: m.content, needs_human: m.needs_human, created_at: m.created_at })),
  });
}));

dash.get('/leads', ah(async (req, res) => {
  res.json(await store.listLeads(req.tenantId));
}));

dash.get('/leads.csv', ah(async (req, res) => {
  const rows = await store.listLeads(req.tenantId, 10_000);
  const cols = ['created_at', 'name', 'email', 'message', 'conversation_id'];
  const csv = [cols.join(','), ...rows.map((r) => cols.map((c) => csvCell(c === 'created_at' ? iso(r[c]) : r[c])).join(','))].join('\r\n');
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="leads.csv"');
  res.send(csv);
}));

app.use('/dash', dash);

// ---------- Widget API (public key) ----------

app.get('/api/widget-config', ah(async (req, res) => {
  const tenant = await widgetTenant(req, res);
  if (!tenant) return;
  res.json({ name: tenant.name, greeting: tenant.greeting, color: tenant.color });
}));

app.post('/api/chat', chatLimiter, ah(async (req, res) => {
  const tenant = await widgetTenant(req, res);
  if (!tenant) return;

  const message = typeof req.body?.message === 'string' ? req.body.message.trim().slice(0, 2000) : '';
  if (!message) return res.status(400).json({ error: 'message is required' });

  const incomingId = req.body?.conversation_id;
  const conversationId = typeof incomingId === 'string' && /^[\w-]{8,64}$/.test(incomingId)
    ? incomingId
    : crypto.randomUUID();

  try {
    const history = await store.getHistory(tenant.id, conversationId, 10);
    const context = searchChunks(await store.listChunks(tenant.id), message, 4);
    const { text, needsHuman } = await answer({ tenant, history, userMessage: message, context });
    await store.saveExchange({ tenantId: tenant.id, conversationId, userMessage: message, reply: text, needsHuman });
    res.json({ conversation_id: conversationId, reply: text, needs_human: needsHuman });
  } catch (err) {
    console.error('chat error:', err.message);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
}));

app.post('/api/leads', leadLimiter, ah(async (req, res) => {
  const tenant = await widgetTenant(req, res);
  if (!tenant) return;

  const email = clip(req.body?.email, 200);
  if (!email || !EMAIL_RE.test(email)) return res.status(400).json({ error: 'a valid email is required' });

  const lead = {
    name: clip(req.body?.name, 200),
    email,
    message: clip(req.body?.message, 2000),
    conversation_id: clip(req.body?.conversation_id, 64),
  };
  await store.saveLead(tenant.id, lead);

  if (tenant.lead_webhook) {
    // Awaited on purpose: serverless functions can stop once the response is sent.
    try {
      await fetch(tenant.lead_webhook, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ site: tenant.name, ...lead, created_at: new Date().toISOString() }),
        signal: AbortSignal.timeout(4000),
      });
    } catch (err) {
      console.error('lead webhook failed:', err.message);
    }
  }
  res.status(201).json({ ok: true });
}));

// ---------- Client API (secret key) ----------

app.post('/api/documents', requireSecret, ah(async (req, res) => {
  const r = await ingestDocument(req.tenant.id, req.body);
  res.status(r.status).json(r.body);
}));

app.delete('/api/documents/:id', requireSecret, ah(async (req, res) => {
  const id = Number(req.params.id);
  const ok = Number.isInteger(id) && (await store.deleteDocument(req.tenant.id, id));
  res.status(ok ? 204 : 404).end();
}));

app.get('/api/leads', requireSecret, ah(async (req, res) => {
  res.json(await store.listLeads(req.tenant.id));
}));

// ---------- Errors ----------

app.use((err, _req, res, _next) => {
  if (err.status && err.status < 500) return res.status(err.status).json({ error: 'Invalid request.' });
  console.error(err);
  res.status(500).json({ error: 'Server error.' });
});

export default app;
