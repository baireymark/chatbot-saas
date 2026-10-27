(function () {
  const script = document.currentScript;
  const KEY = script && script.dataset.key;
  if (!KEY) {
    console.error('[chatbot] Add data-key="pk_..." to the script tag.');
    return;
  }
  const API = (script.dataset.api || new URL(script.src).origin).replace(/\/$/, '');
  const CONV_KEY = 'chatbot_conv_' + KEY;

  function init() {
    const host = document.createElement('div');
    host.id = 'chatbot-host';
    document.body.appendChild(host);
    const root = host.attachShadow({ mode: 'open' });

    root.innerHTML = `
      <style>
        :host { --c: #2563eb; }
        * { box-sizing: border-box; font-family: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; }
        .launcher { position: fixed; right: 20px; bottom: 20px; width: 56px; height: 56px; border-radius: 50%;
          border: 0; cursor: pointer; background: var(--c); color: #fff; font-size: 26px;
          box-shadow: 0 4px 16px rgba(0,0,0,.2); z-index: 2147483000; }
        .panel { position: fixed; right: 20px; bottom: 90px; width: min(360px, calc(100vw - 40px));
          height: min(540px, calc(100vh - 120px)); background: #fff; border-radius: 14px;
          box-shadow: 0 10px 40px rgba(0,0,0,.25); display: flex; flex-direction: column;
          overflow: hidden; z-index: 2147483000; }
        .panel[hidden] { display: none; }
        header { background: var(--c); color: #fff; padding: 14px 16px; display: flex;
          justify-content: space-between; align-items: center; font-weight: 600; }
        .close { background: none; border: 0; color: #fff; font-size: 22px; cursor: pointer; }
        .log { flex: 1; overflow-y: auto; padding: 12px; display: flex; flex-direction: column;
          gap: 8px; background: #f5f5f7; }
        .msg { max-width: 85%; padding: 8px 12px; border-radius: 12px; font-size: 14px;
          line-height: 1.4; white-space: pre-wrap; word-wrap: break-word; }
        .bot { background: #fff; color: #111; align-self: flex-start; border: 1px solid #e5e5e5; }
        .user { background: var(--c); color: #fff; align-self: flex-end; }
        .lead { display: flex; flex-direction: column; gap: 8px; padding: 10px; border-top: 1px solid #eee; background: #fff; }
        .lead[hidden] { display: none; }
        .lead p { margin: 0; font-size: 13px; color: #444; }
        .lead input, .lead textarea, .composer input { width: 100%; padding: 9px 10px; border: 1px solid #ccc;
          border-radius: 8px; font-size: 14px; }
        .lead textarea { resize: vertical; min-height: 56px; }
        .composer { display: flex; gap: 8px; padding: 10px; border-top: 1px solid #eee; background: #fff; }
        button.send, .lead button { background: var(--c); color: #fff; border: 0; border-radius: 8px;
          padding: 9px 14px; cursor: pointer; font-size: 14px; }
        button:disabled { opacity: .6; cursor: default; }
      </style>
      <button class="launcher" aria-label="Open chat">💬</button>
      <section class="panel" hidden role="dialog" aria-label="Chat">
        <header><span class="title">Chat</span><button class="close" aria-label="Close chat">×</button></header>
        <div class="log" aria-live="polite"></div>
        <form class="lead" hidden>
          <p>Leave your details and a team member will follow up.</p>
          <input name="name" placeholder="Your name" autocomplete="name" />
          <input name="email" type="email" placeholder="Email" autocomplete="email" required />
          <textarea name="message" placeholder="What do you need help with?"></textarea>
          <button type="submit">Send to our team</button>
        </form>
        <form class="composer">
          <input name="text" placeholder="Type a message…" autocomplete="off" maxlength="2000" required />
          <button class="send" type="submit">Send</button>
        </form>
      </section>`;

    const $ = (sel) => root.querySelector(sel);
    const launcher = $('.launcher');
    const panel = $('.panel');
    const log = $('.log');
    const composer = $('.composer');
    const leadForm = $('.lead');
    const field = (form, n) => form.querySelector(`[name="${n}"]`);

    let conversationId = null;
    try { conversationId = localStorage.getItem(CONV_KEY); } catch (_) {}
    let greeting = '';

    const safeColor = (c) => (/^#[0-9a-f]{3,8}$/i.test(c || '') ? c : '#2563eb');
    const headers = () => ({ 'Content-Type': 'application/json', 'x-public-key': KEY });

    function addMsg(role, text) {
      const el = document.createElement('div');
      el.className = 'msg ' + (role === 'user' ? 'user' : 'bot');
      el.textContent = text; // textContent, never innerHTML, so visitor text can't inject markup
      log.appendChild(el);
      log.scrollTop = log.scrollHeight;
    }

    fetch(API + '/api/widget-config', { headers: headers() })
      .then((r) => (r.ok ? r.json() : Promise.reject(r.status)))
      .then((cfg) => {
        host.style.setProperty('--c', safeColor(cfg.color));
        $('.title').textContent = cfg.name || 'Chat';
        greeting = cfg.greeting || '';
      })
      .catch(() => {
        launcher.disabled = true;
        launcher.title = 'Chat is unavailable';
      });

    launcher.addEventListener('click', () => {
      panel.hidden = !panel.hidden;
      if (!panel.hidden) {
        if (!log.children.length && greeting) addMsg('bot', greeting);
        field(composer, 'text').focus();
      }
    });
    $('.close').addEventListener('click', () => { panel.hidden = true; });

    composer.addEventListener('submit', async (e) => {
      e.preventDefault();
      const input = field(composer, 'text');
      const text = input.value.trim();
      if (!text) return;
      input.value = '';
      addMsg('user', text);
      const btn = composer.querySelector('button');
      btn.disabled = true;
      try {
        const res = await fetch(API + '/api/chat', {
          method: 'POST',
          headers: headers(),
          body: JSON.stringify({ message: text, conversation_id: conversationId }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Request failed');
        conversationId = data.conversation_id;
        try { localStorage.setItem(CONV_KEY, conversationId); } catch (_) {}
        addMsg('bot', data.reply);
        if (data.needs_human) leadForm.hidden = false;
      } catch (_) {
        addMsg('bot', 'Sorry, something went wrong. Please try again.');
      } finally {
        btn.disabled = false;
        input.focus();
      }
    });

    leadForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      const body = {
        name: field(leadForm, 'name').value.trim(),
        email: field(leadForm, 'email').value.trim(),
        message: field(leadForm, 'message').value.trim(),
        conversation_id: conversationId,
      };
      const btn = leadForm.querySelector('button');
      btn.disabled = true;
      try {
        const res = await fetch(API + '/api/leads', {
          method: 'POST',
          headers: headers(),
          body: JSON.stringify(body),
        });
        if (!res.ok) throw new Error();
        leadForm.reset();
        leadForm.hidden = true;
        addMsg('bot', 'Thanks! Someone from our team will be in touch.');
      } catch (_) {
        addMsg('bot', "We couldn't save your details. Please try again.");
      } finally {
        btn.disabled = false;
      }
    });
  }

  if (document.body) init();
  else document.addEventListener('DOMContentLoaded', init);
})();
