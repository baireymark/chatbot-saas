# Chatbot SaaS

A multi-tenant website chatbot. Each client gets a dashboard, a knowledge base, a branded chat widget, and lead capture. Stack: Vercel (hosting) + Supabase (Postgres).

## Project layout

| Path | Purpose |
|---|---|
| `app.js` | The Express app (API, dashboard API, widget API) |
| `api/index.js` | Vercel entry point. Every request is routed here by `vercel.json` |
| `server.js` | Local development server |
| `lib/db.js` | All database access (Postgres via `pg`) |
| `lib/llm.js` | Claude calls and the handoff rule |
| `lib/retrieval.js` | Chunking and keyword search over the knowledge base |
| `supabase/schema.sql` | Database schema (safe to re-run) |
| `scripts/migrate.js` | Applies the schema |
| `dashboard/` | The client dashboard (static files, served by Vercel) |
| `widget.js` | The embeddable chat widget (static file) |

## Part 1: Supabase (database)

1. Create a project at supabase.com. Save the database password somewhere safe.
2. Get the connection strings: **Project Settings → Database → Connection string**.
   - **Session pooler** (port 5432): use this for running migrations from your computer.
   - **Transaction pooler** (port 6543): use this as `DATABASE_URL` on Vercel. Vercel functions can't always reach Supabase's direct IPv6 address, and the pooler handles many short connections well.
3. Create the tables. From the project folder, on your computer:

   ```bash
   npm install
   cp .env.example .env
   # Set DATABASE_URL in .env to the SESSION pooler string (port 5432)
   npm run db:migrate
   ```

   You'll see `Schema applied.` The schema can be re-run safely. Alternatively, paste `supabase/schema.sql` into the Supabase SQL editor.

Row-level security is turned on for every table in the schema. This blocks anyone who holds the public anon key from reading the tables directly through Supabase's API. The server connects as the table owner, which bypasses that restriction, so the app is unaffected.

## Part 2: Vercel (hosting)

1. Push this folder to a GitHub repository. Don't commit `.env`. The included `.gitignore` excludes it.
2. In Vercel: **Add New → Project**, pick the repository, and deploy. There's no build step. Vercel detects `api/index.js` and `vercel.json` automatically.
3. Before the first deploy (or in Settings → Environment Variables), add:

   | Name | Value |
   |---|---|
   | `DATABASE_URL` | The **transaction pooler** string (port 6543), with your password filled in |
   | `ANTHROPIC_API_KEY` | Your Anthropic API key |
   | `ADMIN_KEY` | A long random string. Generate one with `openssl rand -hex 32` |
   | `MODEL` | `claude-haiku-5-5` |

   Leave `DATABASE_SSL` unset on Vercel. SSL is on by default, which Supabase requires.
4. Redeploy after adding the variables. Your site is at `https://your-project.vercel.app`, and the dashboard is at `https://your-project.vercel.app/dashboard/`.

Or from the terminal: `npm i -g vercel`, then `vercel link`, then `vercel env add` for each variable, then `vercel --prod`.

**Custom domain:** in Vercel, add a domain such as `chat.yourcompany.com` under Settings → Domains. Vercel sets `NODE_ENV` to `production` automatically, so session cookies are marked Secure.

## Part 3: Onboard a client

Create the client and their owner login with the admin API. Replace the URL and key:

```bash
curl -X POST https://your-project.vercel.app/admin/tenants \
  -H "x-admin-key: YOUR_ADMIN_KEY" -H "Content-Type: application/json" \
  -d '{
    "name": "Acme Web Studio",
    "origins": ["https://acmewebstudio.com", "https://www.acmewebstudio.com"],
    "system_prompt": "Friendly and concise. We build websites for small businesses.",
    "greeting": "Hi! Ask me about our packages or timelines.",
    "color": "#0ea5e9",
    "owner_email": "owner@acmewebstudio.com",
    "owner_password": "a-temporary-password-they-change-later"
  }'
```

Send the owner the dashboard link and login. The response includes a secret key that's shown only once. It's only needed for uploading content through the API. The client can also rotate it from Settings.

To add a team member later:

```bash
curl -X POST https://your-project.vercel.app/admin/users \
  -H "x-admin-key: YOUR_ADMIN_KEY" -H "Content-Type: application/json" \
  -d '{"tenant_id": "THE_CLIENT_ID", "email": "staff@acmewebstudio.com", "password": "at-least-10-characters"}'
```

## Part 4: Install on the client's website

The client copies the snippet from the dashboard's **Install widget** page:

```html
<script src="https://your-project.vercel.app/widget.js"
        data-key="pk_..."
        data-api="https://your-project.vercel.app"
        defer></script>
```

The widget only works on the websites listed in the client's Settings.

## Local development

Use a local Postgres or a Supabase development project. Then:

```bash
npm install
cp .env.example .env     # for local Postgres set DATABASE_URL=postgres://... and DATABASE_SSL=false
npm run db:migrate
npm run dev              # http://localhost:3000/dashboard/
```

## Things to know

- **Rate limits** are stored in the database, so they hold across Vercel's instances. Login allows 10 attempts per 15 minutes per IP. Chat allows 20 messages per minute per IP. Adjust these in `app.js`.
- **Function timeouts:** `vercel.json` sets `maxDuration` to 30 seconds. Chat replies normally take a few seconds. If your Vercel plan rejects 30, lower the number to your plan's limit.
- **Commercial use:** Vercel's Hobby plan is for personal, non-commercial projects. Run a paying client's chatbot on the Pro plan.
- **Supabase free tier:** free projects pause after a week of inactivity, and the free database size is limited. Upgrade before you have paying clients.
- **Costs:** you pay for Vercel usage, Supabase, and Anthropic API calls. Each chat turn uses the model's input and output tokens. Haiku is the lowest-cost option here.
- **Secrets:** `ADMIN_KEY`, `ANTHROPIC_API_KEY`, and `DATABASE_URL` belong only in Vercel's environment settings, never in the repository.

## Still to build before charging money

- Billing (Stripe subscriptions, plan limits, usage tracking)
- Self-serve sign-up and password reset
- Email notifications for new leads
- Conversation deletion on request and a retention setting
- Monitoring and error alerts (Vercel logs are available, but nothing alerts you yet)
- Embedding-based search for very large knowledge bases
