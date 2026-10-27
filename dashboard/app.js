// Chatbot dashboard. Plain JavaScript, no build step.
// Server data is always written with textContent (through h()), never innerHTML.

const app = document.getElementById('app');
const NAV = [
  ['overview', 'Overview'],
  ['conversations', 'Conversations'],
  ['leads', 'Leads'],
  ['knowledge', 'Knowledge base'],
  ['settings', 'Settings'],
  ['embed', 'Install widget'],
];
const state = { tenant: null };

class AuthError extends Error {}

function h(tag, props = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v === false || v == null) continue;
    if (k === 'class') el.className = v;
    else if (k === 'value') el.value = v;
    else if (k === 'checked') el.checked = Boolean(v);
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v === true ? '' : String(v));
  }
  for (const c of children.flat(Infinity)) {
    if (c == null || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

async function api(method, path, body) {
  const opts = { method, credentials: 'same-origin', headers: {} };
  if (body !== undefined) {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(body);
  }
  const res = await fetch(path, opts);
  if (res.status === 401 && !path.startsWith('/auth/')) {
    throw new AuthError('Your session ended. Please sign in again.');
  }
  const data = res.status === 204 ? null : await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data?.error || `Request failed (${res.status})`);
  return data;
}

const fmtDate = (s) =>
  s ? new Date(s.includes('T') ? s : s.replace(' ', 'T') + 'Z').toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : '—';

const pageHeader = (title, subtitle, ...actions) =>
  h('div', { class: 'page-head' },
    h('div', {}, h('h1', {}, title), subtitle ? h('p', { class: 'muted' }, subtitle) : null),
    actions.length ? h('div', { class: 'actions' }, actions) : null);

const labelled = (text, hint, control) =>
  h('label', {}, text, hint ? h('span', { class: 'hint' }, hint) : null, control);

const stat = (label, value, hint) =>
  h('div', { class: 'stat' },
    h('div', { class: 'stat-label' }, label),
    h('div', { class: 'stat-value' }, String(value)),
    hint ? h('div', { class: 'stat-hint' }, hint) : null);

function flash(el, text, kind = 'ok') {
  el.textContent = text;
  el.className = `alert ${kind}`;
  el.hidden = false;
}

function copyButton(text) {
  return h('button', {
    class: 'btn ghost small',
    type: 'button',
    onclick: async (e) => {
      const btn = e.currentTarget;
      try {
        await navigator.clipboard.writeText(text);
        btn.textContent = 'Copied';
      } catch {
        btn.textContent = 'Copy failed';
      }
      setTimeout(() => { btn.textContent = 'Copy'; }, 1500);
    },
  }, 'Copy');
}

function handleError(main, ex) {
  if (ex instanceof AuthError) return showLogin(ex.message);
  main.replaceChildren(h('div', { class: 'alert error' }, ex.message));
}

// ---------- Auth and shell ----------

function showLogin(message = '') {
  state.tenant = null;
  const err = h('div', { class: 'alert error', hidden: !message }, message);
  const form = h('form', {
    class: 'card login',
    onsubmit: async (e) => {
      e.preventDefault();
      const btn = form.querySelector('button[type=submit]');
      btn.disabled = true;
      err.hidden = true;
      try {
        await api('POST', '/auth/login', {
          email: form.querySelector('[name=email]').value.trim(),
          password: form.querySelector('[name=password]').value,
        });
        await boot();
      } catch (ex) {
        err.textContent = ex.message;
        err.hidden = false;
        btn.disabled = false;
      }
    },
  },
    h('h1', {}, 'Sign in'),
    h('p', { class: 'muted' }, 'Use the email and password your account manager gave you.'),
    err,
    labelled('Email', null, h('input', { name: 'email', type: 'email', autocomplete: 'username', required: true })),
    labelled('Password', null, h('input', { name: 'password', type: 'password', autocomplete: 'current-password', required: true })),
    h('button', { class: 'btn', type: 'submit' }, 'Sign in'));
  app.replaceChildren(h('div', { class: 'login-wrap' }, form));
}

function showShell() {
  app.replaceChildren(
    h('div', { class: 'shell' },
      h('aside', { class: 'sidebar' },
        h('div', { class: 'brand' }, state.tenant.name),
        h('nav', { class: 'nav' }, NAV.map(([view, label]) =>
          h('a', { href: `#/${view}`, 'data-view': view }, label))),
        h('button', { class: 'linkbtn', onclick: logout }, 'Sign out')),
      h('main', { id: 'view', class: 'main' })));
}

async function logout() {
  await api('POST', '/auth/logout').catch(() => {});
  showLogin('You have been signed out.');
}

async function boot() {
  try {
    const me = await api('GET', '/auth/me');
    state.tenant = me.tenant;
  } catch {
    return showLogin();
  }
  showShell();
  if (!location.hash) history.replaceState(null, '', '#/overview');
  await route();
}

// ---------- Router ----------

function parseHash() {
  const [path, query = ''] = location.hash.replace(/^#\/?/, '').split('?');
  const [name = 'overview', id] = path.split('/');
  return { name, id, params: new URLSearchParams(query) };
}

const VIEWS = { overview, conversations, leads, knowledge, settings, embed };

async function route() {
  if (!state.tenant) return;
  const { name, id, params } = parseHash();
  document.querySelectorAll('.nav a').forEach((a) =>
    a.classList.toggle('active', a.dataset.view === name));
  const main = document.getElementById('view');
  main.replaceChildren(h('p', { class: 'muted' }, 'Loading…'));
  try {
    if (name === 'conversations' && id) await conversationDetail(main, id);
    else if (Object.hasOwn(VIEWS, name)) await VIEWS[name](main, params);
    else await overview(main, new URLSearchParams('days=30'));
  } catch (ex) {
    handleError(main, ex);
  }
}

// ---------- Views ----------

async function overview(main, params) {
  const days = [7, 30, 90].includes(Number(params.get('days'))) ? Number(params.get('days')) : 30;
  const s = await api('GET', `/dash/overview?days=${days}`);

  const byDay = new Map(s.daily.map((d) => [d.day, d.conversations]));
  const series = [];
  for (let i = days - 1; i >= 0; i--) {
    const day = new Date(Date.now() - i * 86400000).toISOString().slice(0, 10);
    series.push({ day, n: byDay.get(day) || 0 });
  }
  const max = Math.max(1, ...series.map((x) => x.n));

  const range = h('select', {
    class: 'select',
    onchange: (e) => { location.hash = `#/overview?days=${e.target.value}`; },
  }, [7, 30, 90].map((d) => h('option', { value: d, selected: d === days }, `Last ${d} days`)));

  main.replaceChildren(
    pageHeader('Overview', 'How your chatbot is doing.', range),
    h('div', { class: 'stats' },
      stat('Conversations', s.conversations),
      stat('Visitor messages', s.messages),
      stat('Handoff rate', `${Math.round(s.handoff_rate * 100)}%`, `${s.handoffs} of ${s.replies} replies`),
      stat('Leads captured', s.leads)),
    h('section', { class: 'card' },
      h('h2', { style: 'margin-top:0' }, 'Conversations per day'),
      h('div', { class: 'chart' }, series.map((x) =>
        h('div', {
          class: 'bar',
          title: `${x.day}: ${x.n}`,
          style: `height:${Math.max(2, Math.round((x.n / max) * 100))}%`,
        }))),
      h('div', { class: 'chart-axis' }, h('span', {}, series[0].day), h('span', {}, series[series.length - 1].day))),
    s.conversations === 0
      ? h('p', { class: 'muted' }, 'No conversations yet. Install the widget on your site to start.')
      : null);
}

async function conversations(main, params) {
  const page = Math.max(1, Number(params.get('page')) || 1);
  const { items } = await api('GET', `/dash/conversations?page=${page}`);

  const rows = items.map((c) => h('tr', {
    class: 'clickable',
    onclick: () => { location.hash = `#/conversations/${c.id}`; },
  },
    h('td', {}, fmtDate(c.last_at)),
    h('td', { class: 'preview' }, h('div', { class: 'trunc' }, c.preview || '—')),
    h('td', {}, String(c.messages)),
    h('td', {}, c.handoffs ? h('span', { class: 'badge warn' }, 'Yes') : '—')));

  main.replaceChildren(
    pageHeader('Conversations', 'Every chat your visitors have had, newest first.'),
    items.length
      ? h('table', { class: 'table' },
          h('thead', {}, h('tr', {},
            h('th', {}, 'Last activity'), h('th', {}, 'First message'),
            h('th', {}, 'Messages'), h('th', {}, 'Handed off'))),
          h('tbody', {}, rows))
      : h('p', { class: 'muted' }, 'No conversations yet.'),
    h('div', { class: 'pager' },
      page > 1 ? h('a', { class: 'btn ghost', href: `#/conversations?page=${page - 1}` }, '← Newer') : null,
      items.length === 25 ? h('a', { class: 'btn ghost', href: `#/conversations?page=${page + 1}` }, 'Older →') : null));
}

async function conversationDetail(main, id) {
  const { messages } = await api('GET', `/dash/conversations/${encodeURIComponent(id)}`);
  main.replaceChildren(
    pageHeader('Conversation', fmtDate(messages[0]?.created_at),
      h('a', { class: 'btn ghost', href: '#/conversations' }, '← Back')),
    h('div', { class: 'transcript' }, messages.map((m) =>
      h('div', { class: `bubble ${m.role}${m.needs_human ? ' handoff' : ''}` },
        h('div', { class: 'who' }, m.role === 'user' ? 'Visitor' : 'Bot'),
        h('div', { class: 'text' }, m.content),
        m.needs_human ? h('div', { class: 'tag' }, 'Handed off to a person') : null))));
}

async function leads(main) {
  const rows = await api('GET', '/dash/leads');
  main.replaceChildren(
    pageHeader('Leads', 'People who asked to be contacted.',
      h('a', { class: 'btn', href: '/dash/leads.csv' }, 'Download CSV')),
    rows.length
      ? h('table', { class: 'table' },
          h('thead', {}, h('tr', {}, ...['Date', 'Name', 'Email', 'Message', 'Chat'].map((t) => h('th', {}, t)))),
          h('tbody', {}, rows.map((r) => h('tr', {},
            h('td', {}, fmtDate(r.created_at)),
            h('td', {}, r.name || '—'),
            h('td', {}, h('a', { href: `mailto:${r.email}` }, r.email)),
            h('td', { class: 'wrap' }, r.message || '—'),
            h('td', {}, r.conversation_id
              ? h('a', { href: `#/conversations/${r.conversation_id}` }, 'View')
              : '—')))))
      : h('p', { class: 'muted' }, 'No leads yet.'));
}

async function knowledge(main) {
  const docs = await api('GET', '/dash/documents');
  const msg = h('div', { class: 'alert', hidden: true });
  const titleInput = h('input', { name: 'title', maxlength: 200, required: true, placeholder: 'e.g. Pricing 2026' });
  const bodyInput = h('textarea', {
    name: 'content', rows: 10, required: true,
    placeholder: 'Paste pricing, FAQs, service descriptions, policies, or case studies…',
  });
  const fileInput = h('input', {
    type: 'file', accept: '.txt,.md,.csv',
    onchange: async (e) => {
      const file = e.target.files[0];
      if (!file) return;
      if (file.size > 500_000) return flash(msg, 'That file is too large (max about 500 KB of text).', 'error');
      if (!titleInput.value) titleInput.value = file.name.replace(/\.[^.]+$/, '');
      bodyInput.value = await file.text();
    },
  });

  const form = h('form', {
    class: 'card form',
    onsubmit: async (e) => {
      e.preventDefault();
      const btn = form.querySelector('button[type=submit]');
      btn.disabled = true;
      try {
        await api('POST', '/dash/documents', { title: titleInput.value.trim(), content: bodyInput.value });
        knowledge(main);
      } catch (ex) {
        flash(msg, ex.message, 'error');
        btn.disabled = false;
      }
    },
  },
    labelled('Title', null, titleInput),
    labelled('Upload a text file (optional)', 'Plain text, Markdown, or CSV. You can also paste below.', fileInput),
    labelled('Content', 'Long documents are split into searchable pieces automatically.', bodyInput),
    h('div', {}, h('button', { class: 'btn', type: 'submit' }, 'Add to knowledge base')));

  const rows = docs.map((d) => h('tr', {},
    h('td', {}, d.title),
    h('td', {}, String(d.chunks)),
    h('td', {}, d.chars.toLocaleString()),
    h('td', {}, fmtDate(d.created_at)),
    h('td', {}, h('button', {
      class: 'btn ghost small',
      onclick: async () => {
        if (!confirm(`Delete "${d.title}" from the knowledge base?`)) return;
        try {
          await api('DELETE', `/dash/documents/${d.id}`);
          knowledge(main);
        } catch (ex) {
          flash(msg, ex.message, 'error');
        }
      },
    }, 'Delete'))));

  main.replaceChildren(
    pageHeader('Knowledge base', 'What the chatbot knows about your business.'),
    msg,
    docs.length
      ? h('table', { class: 'table' },
          h('thead', {}, h('tr', {}, ...['Title', 'Chunks', 'Characters', 'Added', ''].map((t) => h('th', {}, t)))),
          h('tbody', {}, rows))
      : h('p', { class: 'muted' }, 'Nothing here yet. Add your pricing, FAQs, services, and policies below.'),
    h('h2', {}, 'Add a document'),
    form);
}

async function settings(main) {
  const s = await api('GET', '/dash/settings');
  const msg = h('div', { class: 'alert', hidden: true });
  const f = {
    name: h('input', { name: 'name', required: true, maxlength: 120, value: s.name }),
    greeting: h('input', { name: 'greeting', maxlength: 300, value: s.greeting }),
    color: h('input', { name: 'color', type: 'color', value: s.color }),
    system_prompt: h('textarea', { name: 'system_prompt', rows: 6, maxlength: 4000, value: s.system_prompt }),
    origins: h('textarea', { name: 'origins', rows: 3, placeholder: 'https://yoursite.com', value: s.origins.join('\n') }),
    lead_webhook: h('input', { name: 'lead_webhook', type: 'url', placeholder: 'https://hooks.zapier.com/…', value: s.lead_webhook }),
  };

  const form = h('form', {
    class: 'card form',
    onsubmit: async (e) => {
      e.preventDefault();
      const btn = form.querySelector('button[type=submit]');
      btn.disabled = true;
      try {
        await api('PUT', '/dash/settings', {
          name: f.name.value.trim(),
          greeting: f.greeting.value.trim(),
          color: f.color.value,
          system_prompt: f.system_prompt.value.trim(),
          origins: f.origins.value.split('\n').map((x) => x.trim()).filter(Boolean),
          lead_webhook: f.lead_webhook.value.trim(),
        });
        document.querySelector('.brand').textContent = f.name.value.trim();
        state.tenant.name = f.name.value.trim();
        flash(msg, 'Saved.', 'ok');
      } catch (ex) {
        flash(msg, ex.message, 'error');
      } finally {
        btn.disabled = false;
      }
    },
  },
    labelled('Business name', null, f.name),
    labelled('Greeting', 'The first message visitors see when they open the chat.', f.greeting),
    labelled('Brand color', null, f.color),
    labelled('Instructions for the bot', 'Tone, what to emphasize, what to avoid. Facts come from your knowledge base.', f.system_prompt),
    labelled('Allowed websites', 'One per line, e.g. https://yoursite.com. The widget only runs on these.', f.origins),
    labelled('Lead notifications webhook', 'Optional. We send each new lead as JSON to this address (Zapier, Make, a CRM, and so on).', f.lead_webhook),
    h('div', {}, h('button', { class: 'btn', type: 'submit' }, 'Save settings')));

  const secretBox = h('div', { class: 'secret', hidden: true });
  const rotate = async () => {
    if (!confirm('Create a new secret key? The current one stops working right away for uploads from your systems.')) return;
    try {
      const r = await api('POST', '/dash/secret/rotate');
      secretBox.replaceChildren(
        h('strong', {}, 'New secret key'),
        h('p', { class: 'muted' }, 'Shown once. Copy it now and store it somewhere safe.'),
        h('code', {}, r.secret_key),
        copyButton(r.secret_key));
      secretBox.hidden = false;
    } catch (ex) {
      flash(msg, ex.message, 'error');
    }
  };

  main.replaceChildren(
    pageHeader('Settings', 'Business details, chatbot behavior, and where the widget may run.'),
    msg,
    form,
    h('section', { class: 'card' },
      h('h2', { style: 'margin-top:0' }, 'API access'),
      h('p', { class: 'muted' }, 'Use the secret key to upload content from your own systems. Keep it private.'),
      h('button', { class: 'btn danger', onclick: rotate }, 'Rotate secret key'),
      secretBox));
}

async function embed(main) {
  const s = await api('GET', '/dash/settings');
  const origin = location.origin;
  const snippet = `<script src="${origin}/widget.js"\n        data-key="${s.public_key}"\n        data-api="${origin}"\n        defer></script>`;
  main.replaceChildren(
    pageHeader('Install the widget', 'Paste this into any page on your allowed websites, for example just before </body>.'),
    s.origins.length ? null : h('div', { class: 'alert warn' }, 'Add at least one allowed website in Settings, or the widget will not load.'),
    h('section', { class: 'card' },
      h('pre', { class: 'code' }, snippet),
      copyButton(snippet)),
    h('p', { class: 'muted' },
      'Your public key is ', h('code', {}, s.public_key),
      '. It is safe to publish: it only works on the websites listed in Settings.'));
}

// ---------- Start ----------

window.addEventListener('hashchange', route);
boot();
