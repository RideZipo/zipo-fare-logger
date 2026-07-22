# Zipo Fare Logger — multi-database web app

A small web app for logging London taxi fares over time so you can analyse
when prices are highest. On the login screen each person picks (or creates)
their own **database** — under the hood each database is a dedicated Supabase
Auth account, and Row Level Security scopes every read/write to the rows that
account created. So each database's logged fares are private to whoever knows
its password; nobody sees another database's entries.

The app is plain static files — no build step, no framework, no bundler.

```
index.html                        the fare logger (gated: redirects to login if signed out)
login.html                        database picker + "create a new database" + sign-in
config.js                         <-- paste your Supabase URL + anon key here
supabase-setup.sql                tables + Row Level Security policies (run once)
netlify.toml                      Netlify deploy config
netlify/functions/signals-proxy.js  server-side proxy to the Zipo Pricing Model's live signals
scripts/fix-observation-times.mjs repairs obs_date/obs_time on pre-timezone-fix rows
scripts/backfill-weather.mjs      fills historical weather into rows that have none
scripts/lib/                      shared helpers for the scripts (London time, PostgREST)
README.md                         this file
```

The two `scripts/` entries are **local admin tools**, not part of the deployed
site — they are run by hand from a terminal and are 404'd on Netlify.

Every logged fare also captures the Zipo Pricing Model's live signals
(weather, TfL, events, sports, rail, strikes, traffic — whatever's currently
in its Redis cache) **for that fare's pickup location only** — not a
London-wide dump — via `netlify/functions/signals-proxy.js`, so you can
later correlate a logged fare against the conditions at that moment and
location. This is best-effort: if the pricing model is unreachable, the fare
still saves, just without a snapshot. See "Signals snapshot" below for
setup.

---

## What each database can do

- **Read/write:** an authenticated account only ever sees and edits the
  `fare_entries` rows it created itself — RLS enforces this in Postgres, not
  just the UI. The route/tier catalogue and fare defaults (the "Config" tab)
  are the one exception: they're **shared across every database** so everyone
  logs against the same route list and starting fare numbers.
- **Deleting requires a password.** Both the big "Clear data" wipe *and*
  deleting a single row prompt for the password set near the top of the script
  in `index.html` (`DELETE_PASSWORD`, default `Zipo2026` — change it). This is a
  UI safeguard against accidental deletion, not a security boundary: it's
  visible in the page source, so change it before going live.
- **Logged-out visitors:** see nothing — the page redirects to the login
  screen, and the database rejects all reads/writes (enforced by RLS).
- **Creating a new database** is self-service from the login screen (see
  "How it fits together" below) — anyone who can reach the login page can spin
  up a new one. If you want to lock that down instead, see the security note
  at the bottom.

---

## Setup — do these in order

### 1. Create a Supabase project

1. Go to https://supabase.com, sign in, and click **New project**.
2. Give it a name (e.g. `zipo-fare-logger`), set a strong database password
   (you won't need it for this app), pick a region near London, and create it.
3. Wait ~1–2 minutes for it to finish provisioning.

### 2. Create the table + security policies

1. In your project, open **SQL Editor** (left sidebar) → **New query**.
2. Open `supabase-setup.sql` from this folder, copy the whole file, paste it in.
3. Click **Run**. You should see "Success. No rows returned."

This creates the `fare_entries` table, indexes, turns on Row Level Security, and
adds the shared-feed policies (authenticated users only).

### 3. Get your URL and anon key, and put them in `config.js`

1. Go to **Project Settings** (gear icon) → **API**.
2. Copy two values:
   - **Project URL** — looks like `https://abcdxyz.supabase.co`
   - **Project API keys → `anon` `public`** — a long string starting `eyJ...`
3. Open `config.js` and paste them in:

   ```js
   window.ZIPO_CONFIG = {
     SUPABASE_URL: "https://abcdxyz.supabase.co",
     SUPABASE_ANON_KEY: "eyJhbGciOi...your-anon-key..."
   };
   ```

   The **anon key is safe to ship in the browser** — it can only do what your RLS
   policies allow, and those require a signed-in user. **Never** paste the
   `service_role` key here; it bypasses RLS.

### 4. Turn ON sign-up, turn OFF email confirmation

The login screen's "+ Create a new database" button creates its backing
Supabase Auth account itself, straight from the browser (`auth.signUp`) — so,
unlike a typical invite-only setup, sign-up needs to be **allowed**:

1. Go to **Authentication** → **Providers** (or **Sign In / Providers**).
2. Under **Email**, make sure the provider is **enabled**, and that "Allow new
   users to sign up" is **ON**. (Depending on dashboard version this may
   instead live under **Authentication → Settings** as "Disable sign-ups" /
   "User Signups" — whichever wording you see, make sure self-service sign-up
   is **allowed**.)
3. Under the same **Providers → Email** section, turn **OFF** "Confirm email".
   Each new database's backing account uses a synthetic email address with no
   real inbox behind it (derived from the database name), so it can never
   click a confirmation link. Leaving confirmation on would lock every newly
   created database out immediately after creation.

### 5. Adding databases

The normal way is self-service: on the login screen, click **"+ Create a new
database"**, give it a name and password, and it's ready immediately — no
dashboard work needed. Each name maps to one Supabase Auth account (see the
`databases` table added by `supabase-setup.sql`), and RLS keeps its
`fare_entries` rows private to that account.

You can also create one by hand in **Authentication → Users → Add user**
(tick **Auto Confirm User**) — if you do, also insert a matching row into the
`databases` table (`name`, and `email` matching the account you created) so it
shows up in the login picker.

To remove a database later, delete its account under **Authentication →
Users** and delete its row from the `databases` table; its `fare_entries` rows
can be deleted too if you no longer need that data.

### 6. Test locally (optional but wise)

Because the app loads `config.js` and talks to Supabase over HTTPS, opening
`index.html` from a `file://` path can hit browser restrictions. Serve the folder
over HTTP instead:

```bash
# any one of these, from inside this folder:
python3 -m http.server 8080
# or
npx serve .
```

Then visit http://localhost:8080/login.html, sign in with a user you created,
and confirm you can log a fare and see it appear. Open the same URL in a second
browser (or an incognito window) signed in as a different user to confirm the
feed is shared.

### 7. Deploy to Netlify

**Option A — drag-and-drop (fastest):**

1. Make sure `config.js` has your real URL + anon key saved.
2. Go to https://app.netlify.com → **Add new site** → **Deploy manually**.
3. Drag this entire folder onto the drop zone.
4. Netlify gives you a live URL. Visit it, and you'll land on the login page.

**Option B — Git (nicer for updates):**

1. Push this folder to a GitHub/GitLab repo. `config.js` holds only the public
   anon key, so it's fine to commit. (Do **not** commit any service_role key or
   the `add-user.mjs` script if you filled its key in.)
2. In Netlify: **Add new site** → **Import an existing project** → pick the repo.
3. Leave the build command empty and publish directory as `.` (the included
   `netlify.toml` already sets this). Deploy.
4. Future `git push`es redeploy automatically.

### 8. Signals snapshot (optional but recommended)

Each logged fare captures the Zipo Pricing Model's live signals via a
Netlify Function that keeps the pricing model's API key out of the browser.
The function takes the observation's pickup `lat`/`lng`, resolves which H3
signal zone that falls in (via `GET /v1/pricing`, discarding everything
price-related from that response — only the zone is used), then fetches
`GET /v1/admin/signals`, keeps just that one zone's data per source, and
strips each source down to raw/reported values (e.g. weather's `rain_mm` /
`temp_c` / `wind_ms`) — Zipo's own computed demand scores, severities, and
attendance estimates are dropped. See `stripComputed()` in
`netlify/functions/signals-proxy.js` for the exact field list per source. To
enable it:

1. In Netlify: **Site configuration** → **Environment variables**, add:
   - `PRICING_MODEL_URL` — base URL of the Zipo Pricing Model API (e.g.
     `http://<ec2-host>:8000`), no trailing slash.
   - `PRICING_MODEL_API_KEY` — its `X-API-Key` (the same server-to-server key
     used elsewhere, e.g. `ziporide-api`'s `PRICING_MODEL_API_KEY`). **Never**
     put this in `config.js` or any committed file — it belongs only here.
2. Redeploy so the function picks up the new environment variables.

If these aren't set, or the pricing model is unreachable when a fare is
logged, the fare still saves — the `signals_*` columns are just stored as
`NULL` for that row, and a small toast says so.

**Existing installs:** if your Supabase project was set up before these
columns existed, either re-run the whole `supabase-setup.sql` (safe,
additive, and drops the older single-blob `signals_snapshot` column from an
earlier iteration of this feature if present) or just run:

```sql
alter table public.fare_entries add column if not exists signals_weather jsonb;
alter table public.fare_entries add column if not exists signals_tfl jsonb;
alter table public.fare_entries add column if not exists signals_events jsonb;
alter table public.fare_entries add column if not exists signals_sports jsonb;
alter table public.fare_entries add column if not exists signals_rail jsonb;
alter table public.fare_entries add column if not exists signals_strikes jsonb;
alter table public.fare_entries add column if not exists signals_traffic jsonb;
```

### 9. Backfilling weather into older rows

Signals capture only started on 2026-07-20, and until the `PM1` fix the pricing
model filtered out any signal it didn't deem "significant" — and weather's gate
is `demand_pressure > 0`, which is zero on any ordinary fair-weather day. So
plenty of rows carry `signals_weather = NULL` even though the weather that day
is perfectly well known. `scripts/backfill-weather.mjs` fills those in from
[Open-Meteo](https://open-meteo.com)'s historical archive (free, no API key),
writing the same `rain_mm` / `temp_c` / `wind_ms` shape the live capture uses:

```bash
# always dry-run first — it writes nothing and prints what it would do
SUPABASE_SERVICE_ROLE_KEY=... node scripts/backfill-weather.mjs --dry-run

SUPABASE_SERVICE_ROLE_KEY=... node scripts/backfill-weather.mjs
```

Plain Node 18+, no dependencies, no `npm install`. Find the key under **Project
Settings → API → `service_role`**. It **bypasses Row Level Security** — which is
exactly why the backfill needs it (it has to reach every database's rows, not
just one account's), and exactly why it must stay in your shell for the length
of one command. Never put it in `config.js`, in a committed file, or in
Netlify's environment.

**Grant, run, revoke.** This project deliberately does *not* give `service_role`
any privileges on its tables — only `anon` and `authenticated` are ever granted,
so a leaked `service_role` key is inert against your fare data. That is a
stronger posture than stock Supabase, and the backfill does not permanently
undo it. Instead, open the **SQL Editor** and elevate for the duration of the
run only:

```sql
-- 1. before the backfill
grant select, update on public.fare_entries to service_role;
```

Run the script, then immediately put it back:

```sql
-- 2. as soon as the backfill finishes
revoke select, update on public.fare_entries from service_role;
```

If you skip step 1 the script fails fast with PostgREST error `42501`
("permission denied for table fare_entries") and writes nothing. **Rotate the
`service_role` key afterwards if it has been pasted anywhere it might persist**
— a chat log, a shell history file, a terminal scrollback.

Two properties worth knowing:

- **It only ever fills `NULL`s.** The `signals_weather=is.null` filter is part
  of the `PATCH` itself, not just the row selection, so a live-captured value
  cannot be overwritten even if the script is re-run or races with a live
  logger. Re-running is safe and reports 0 rows filled.
- **Backfilled values are labelled.** Each blob carries `_source` and
  `_backfilled_at`; live-captured blobs have neither. So
  `signals_weather ? '_source'` separates reanalysis data from point
  observations at analysis time — they come from different providers
  (Open-Meteo vs OpenWeatherMap) and shouldn't be silently pooled.

The script reads each row's hour from `obs_date` + `obs_time` as London wall
clock, and reports any row where that disagrees with the server-side
`created_at` by more than 2 hours. **Run `scripts/fix-observation-times.mjs`
first** (below) and that report should come back empty — a non-zero count means
some rows would get the wrong hour's weather.

### Repairing observation times

Before 2026-07-20 the app took `obs_date` from `toISOString()` (UTC) but
`obs_time` from `toTimeString()` (the *device's* zone). For anyone logging from
outside the UK, or across midnight, the two halves describe different clocks, so
the stored observation time is wrong. `londonDateTime()` fixed this going
forward; `scripts/fix-observation-times.mjs` repairs the rows already written.

```bash
SUPABASE_SERVICE_ROLE_KEY=... node scripts/fix-observation-times.mjs --dry-run
SUPABASE_SERVICE_ROLE_KEY=... node scripts/fix-observation-times.mjs
```

It finds rows whose stated time disagrees with `created_at` by more than 2 hours
and rewrites them from `created_at`, which — because tiers are written within
seconds of the observation — sits within a minute or two of the real instant.

Two things it gets right that are easy to get wrong:

- **It repairs per observation, not per row.** `beginWith()` captures one
  `londonDateTime(now)` and shares it across every vehicle tier, so an
  observation is typically 5 rows carrying one identical timestamp while their
  `created_at` values can span half an hour. The fix groups rows the way the app
  grouped them and anchors each group to its *earliest* `created_at`, so one
  observation keeps one time instead of fracturing into five.
- **It backs up before writing.** Unlike the weather backfill this edits
  observation data, so it dumps every prior value to `obs-time-backup-<ts>.json`
  first. Keep that file — it is the undo.

**Run order is: repair, then backfill.** The backfill derives each row's hour
from the observation time, so repairing afterwards would leave the weather
pinned to the wrong hour.

*(Applied 2026-07-22: 50 rows across 10 observation groups — one contributor's
device on UTC+5:30, and a set of past-midnight rows whose date and time came
from different clocks and so landed a full day early.)*

**Events are not backfillable.** Ticketmaster's Discovery API — the source the
pricing model uses — drops events from its index as soon as they are over
(measured 2026-07-22: 147 events for that day, 0 for the day before). There is
no historical events data to fetch, so `signals_events` is left alone. See
`PM3` in the master plan for the options.

---

## How it fits together

- **`login.html`** first shows a picker built from the `databases` table (just
  a name → backing-email directory). Pick a name → enter its password → it
  calls `auth.signInWithPassword` under that database's real account. Click
  "+ Create a new database" → give it a name + password → it calls
  `auth.signUp` with a synthetic email derived from the name, adds a row to
  `databases`, and signs straight in. Either way, success redirects to
  `index.html`. If already signed in, it skips straight to the app.
- **`index.html`** checks for a session on load. No session → redirect to
  `login.html`. With a session → it shows the logger, loads that account's own
  entries, and every capture/edit/delete writes straight to Supabase, scoped
  to that account by RLS. The topbar shows the database's friendly name
  (looked up from `databases` by email) next to a coloured sync dot (green =
  synced, amber = saving, red = error). "Sign out" ends the session and
  returns to the picker.
- **Config** (the route/tier catalogue, weights, and sampling mode under
  "Config") is **shared across every database** — stored as a single row in
  the `app_config` table. Editing it writes through to Supabase (debounced),
  and everyone picks up the change on their next load. Concurrent edits are
  last-write-wins.
- **Export CSV** still works and exports the currently signed-in database's
  own entries.

## The data

Table `fare_entries`, one row per logged vehicle-tier observation. Numeric fields
are nullable — an empty input or a skipped tier is stored as `NULL` (cleaner for
analysis than a sentinel string). Each row records `created_by` (the account —
i.e. database — that logged it) and `created_at` (server timestamp); RLS uses
`created_by` to keep each database's rows private to itself. The 7
`signals_weather` / `signals_tfl` / `signals_events` / `signals_sports` /
`signals_rail` / `signals_strikes` / `signals_traffic` columns (jsonb,
nullable) each hold that source's live-signal data for this entry's *pickup*
H3 signal zone, captured at logging time (see "Signals snapshot" above).
`NULL` means either no snapshot was captured for the row at all (fetch
failed, or the row predates these columns) or that specific source had no
active signal in this entry's zone — the two aren't distinguished; re-derive
the pickup zone from `origin_lat`/`origin_lng` if that distinction matters.

`signals_weather` is the one column that may also hold **backfilled** data,
written after the fact by `scripts/backfill-weather.mjs` rather than captured
live (see step 9). Those blobs carry `_source` and `_backfilled_at` alongside
the usual three fields; live-captured ones carry neither, so the two are always
separable:

```sql
select count(*) filter (where signals_weather is null)         as no_weather,
       count(*) filter (where signals_weather ? '_source')     as backfilled,
       count(*) filter (where signals_weather is not null
                          and not signals_weather ? '_source') as live_captured
from public.fare_entries;
```

Table `databases`: just `name` (shown in the login picker) and `email` (the
synthetic address behind that name's Supabase Auth account) — enough for the
picker to list names and resolve which account to sign in as. It holds no
fare data itself.

## Security notes

- Row-level isolation is enforced by **Row Level Security in Postgres**, not
  just the UI: an authenticated request can only read/write `fare_entries`
  rows where `created_by` matches its own account, regardless of what the
  client asks for.
- The **anon key in `config.js` is meant to be public.** The key that must stay
  secret is the **service_role** key — this app never needs it; keep it out of
  the web app and out of any public repo.
- **Self-service database creation is open to anyone who can reach the login
  page** (step 4 requires sign-up to be enabled) — there's no invite gate on
  it. Each new database's data is still private once created (RLS), but
  someone could create junk databases. If you'd rather lock creation down to
  an admin instead, disable public sign-up again (undoing step 4) and create
  each database's account by hand as described in step 5, adding a matching
  row to `databases` yourself.
- **Deleting requires a password** (`DELETE_PASSWORD` in `index.html`) is a UI
  safeguard only, visible in the page source — change it before going live,
  but don't rely on it as real access control.
