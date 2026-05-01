# Calendar Agent — Tenex Take-Home

A production-grade AI calendar assistant. Connect your Google account, talk to your schedule, get email drafts you can send in one click.

**Live demo:** [your-deployed-url]
**Video walkthrough:** [YouTube unlisted link]

---

## What It Does

- Syncs your Google Calendar and displays it in a day / week / month view
- Streaming AI chat grounded in your real calendar data — no hallucinated meetings
- Asks the AI to draft scheduling emails → renders them as interactive cards → one click pre-fills the compose panel → sends from your Gmail
- Finds open meeting slots and books them directly to Google Calendar
- Meeting load analytics with actionable recommendations to reclaim focus time

---

## Architecture

```
Google OAuth (Supabase)
        │
        ├─ provider_token ──► Google Calendar API ──► Supabase Postgres (calendar_events)
        │
        └─ provider_token ──► Gmail API (send only, gmail.send scope)

Client (Next.js)
        │
        └─ /api/chat ──► OpenAI streaming SSE ──► ReadableStream ──► token-by-token UI update
                              │
                              └─ [EMAIL_DRAFT] parser ──► EmailDraftCard component
                                                               │
                                                               └─ Compose panel ──► Gmail API
```

**Key design decisions:**

1. **Grounded AI** — the system prompt injects your real synced events as JSON facts. The model can only reference events that exist. Hallucinated attendees, times, and meeting titles are explicitly blocked by the prompt.
2. **Structured email output** — the model wraps drafts in `[EMAIL_DRAFT]...[/EMAIL_DRAFT]` tags. The UI parses these into interactive cards with parsed To / Subject / Body fields and a direct compose path. No copy-paste.
3. **Streaming** — `stream: true` on the OpenAI request, `ReadableStream` piped to the client. Tokens appear in real time instead of after a multi-second wait.
4. **Rate limiting** — 20 requests per user per minute, in-memory sliding window. Comment in `lib/rate-limit.ts` marks exactly where Redis goes for multi-instance deployments.

---

## Tech Stack


| Layer     | Choice                              | Reason                                            |
| --------- | ----------------------------------- | ------------------------------------------------- |
| Framework | Next.js 16 (App Router)             | API routes + client components in one repo        |
| Auth + DB | Supabase                            | Google OAuth, Postgres, RLS in hours not days     |
| AI        | OpenAI (streaming)                  | SSE streaming API, `gpt-4o-mini` by default       |
| Calendar  | Google Calendar API                 | Read + write via `provider_token`                 |
| Email     | Gmail API (`gmail.send`)            | Least-privilege scope, sends as the user          |
| Styling   | Tailwind CSS + custom design tokens | Dark-mode first, consistent variable system       |
| Language  | TypeScript (strict)                 | End-to-end types across API routes and components |


---

## Trade-offs

- **In-memory rate limiter** — works for a single server instance. Replace with Redis for horizontal scaling (the swap point is one line in `lib/rate-limit.ts`).
- `**provider_token` expiry** — Google tokens expire after 1 hour. Currently the user re-authenticates. Production fix: store the refresh token server-side in Supabase and auto-refresh silently.
- **Full calendar context in prompt** — sends up to 300 events per chat request. Scales well for individual users; for enterprise you'd embed events and do vector retrieval to pull only the semantically relevant ones.
- **Dashboard page size** — key pieces are extracted (`EmailDraftCard`, `lib/message-parser.ts`, `lib/rate-limit.ts`) but the main dashboard component is still large. Full decomposition is the next refactor.

---

## Next Steps

1. **Refresh token persistence** — store server-side, refresh silently. Eliminates the 1-hour re-auth.
2. **Persistent chat history** — save conversations to Supabase per user so context survives page reloads.
3. **Vector search over events** — embed calendar events, retrieve only semantically relevant ones per query. Scales AI context to years of history.
4. **Mobile (Expo)** — same Supabase backend, same Google OAuth, native calendar feel.
5. **Team scheduling** — connect multiple team members, find times that work across all of them, book in one action.

---

## Local Setup

### Prerequisites

- Node.js 18+
- A Supabase project
- A Google Cloud project with Calendar API and Gmail API enabled
- An OpenAI API key

### 1. Clone and install

```bash
git clone [repo-url]
cd sched
npm install
```

### 2. Environment variables

Create a `.env` file in the project root:

```env
# Supabase
NEXT_PUBLIC_SUPABASE_URL=https://your-project.supabase.co
NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=your-supabase-anon-key

# OpenAI
NEXT_PUBLIC_AI_API_KEY=sk-...
NEXT_PUBLIC_AI_API_ENDPOINT=https://api.openai.com/v1/chat/completions
```

### 3. Supabase setup

Enable the Google provider in **Authentication → Providers → Google** and paste your Google OAuth client ID and secret.

Run this SQL in your Supabase SQL editor to create the required tables:

```sql
create table calendar_events (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references auth.users not null,
  google_event_id text not null,
  title text not null,
  description text,
  location text,
  attendee_emails text[],
  organizer_email text,
  starts_at timestamptz not null,
  ends_at timestamptz not null,
  status text,
  html_link text,
  raw jsonb,
  updated_at timestamptz default now(),
  unique(user_id, google_event_id)
);

create table calendar_syncs (
  user_id uuid primary key references auth.users,
  synced_at timestamptz not null,
  event_count int not null default 0
);

alter table calendar_events enable row level security;
alter table calendar_syncs enable row level security;

create policy "Users see own events" on calendar_events
  for all using (auth.uid() = user_id);

create policy "Users see own syncs" on calendar_syncs
  for all using (auth.uid() = user_id);
```

### 4. Google Cloud setup

1. Go to [console.cloud.google.com](https://console.cloud.google.com)
2. Enable **Google Calendar API** and **Gmail API**
3. Under **OAuth consent screen → Scopes**, add:
  - `https://www.googleapis.com/auth/calendar.events`
  - `https://www.googleapis.com/auth/gmail.send`
4. Register your Supabase callback URL as an authorized redirect URI:
  `https://your-project.supabase.co/auth/v1/callback`

### 5. Run

```bash
npm run dev
```

Open [http://localhost:3000](http://localhost:3000), click **Continue with Google**, grant calendar and Gmail permissions, and you're in.

---

## Project Structure

```
app/
  page.tsx                  # Landing / Google sign-in
  dashboard/page.tsx        # Main dashboard
  api/
    chat/route.ts           # Streaming AI chat with calendar context
    calendar/
      sync/route.ts         # Pull events from Google Calendar → Supabase
      events/route.ts       # Read events from Supabase
      create/route.ts       # Create Google Calendar event
      cancel-all/route.ts   # Bulk cancel meetings
    gmail/
      send/route.ts         # Send email via Gmail API

components/
  dashboard/
    EmailDraftCard.tsx      # Parsed email draft with compose button
  ui/                       # Shared UI primitives

lib/
  message-parser.ts         # [EMAIL_DRAFT] tag parser
  rate-limit.ts             # Sliding window rate limiter
  supabase.ts               # Client-side Supabase instance
  server-supabase.ts        # Server-side Supabase + bearer token helper
```

---

## [Video Outline]()


| [Section]()         | [Time]() | [Content]()                                                                                  |
| ------------------- | -------- | -------------------------------------------------------------------------------------------- |
| [Opening]()         | [0:00]() | [What I built and why]()                                                                     |
| [Demo]()            | [0:30]() | [Login → calendar → streaming chat → email draft cards → compose → send → meeting booking]() |
| [Why this way]()    | [2:30]() | [Grounded AI, structured output, streaming — what makes it a system not a demo]()            |
| [Architecture]()    | [4:00]() | [Auth → Calendar API → Supabase → OpenAI stream → email parser → Gmail]()                    |
| [Trade-offs]()      | [6:00]() | [Rate limiter, token expiry, context window, page size]()                                    |
| [Business impact]() | [7:00]() | [Scheduling overhead is the real problem, not the meetings themselves]()                     |
| [Next steps]()      | [7:45]() | [Refresh tokens, chat history, vector search, mobile, team view]()                           |
| [Close]()           | [8:30]() | [GitHub, live link, open to questions]()                                                     |


