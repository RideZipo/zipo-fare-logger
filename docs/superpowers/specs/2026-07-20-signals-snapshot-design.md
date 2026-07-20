# Signals snapshot on fare entries

Date: 2026-07-20

## Problem

The fare logger records manually-observed London taxi fares (`fare_entries`) but
has no record of what conditions the Zipo Pricing Model was seeing at the
moment each fare was logged — weather, active events, TfL disruptions, etc.
Without that, logged fares can't be correlated against the conditions that
would explain why a fare was high or low at that time.

## Goal

On every fare entry logged through the app, also capture and store a snapshot
of the Zipo Pricing Model's current live signals (the same data backing
`GET /v1/admin/signals` on the pricing model API, EC2-hosted, which itself
reads from Redis) — not a computed Zipo price. Never block a fare save on
this: it's a secondary enrichment.

## Architecture

```
Browser (index.html)
  │  on insertRow() — new fare entry
  ▼
Netlify Function: /.netlify/functions/signals-proxy
  │  GET {PRICING_MODEL_URL}/v1/admin/signals
  │  header: X-API-Key: {PRICING_MODEL_API_KEY}   (Netlify env vars, server-side only)
  ▼
Zipo Pricing Model API (EC2)
  → reads live signals (weather/tfl/events/sports/rail/strikes/traffic) from Redis
  → returns SignalsStatusResponse JSON
```

The pricing model's `/v1/admin/signals` endpoint requires `X-API-Key` (the
same `ADMIN_API_KEY` used server-to-server elsewhere) or an operator Bearer
JWT. This static site has no operator-login system and cannot safely ship
that key in `config.js` the way it ships the Supabase anon key — the anon key
is safe to expose by design (RLS-gated); `ADMIN_API_KEY` is not. So the key
lives only in a Netlify Function's environment variables, never in code or
the browser bundle. This mirrors the fix already applied to the admin panel's
key-in-bundle issue.

### New file: `netlify/functions/signals-proxy.js`

- Node runtime, no dependencies (uses the Netlify Node runtime's built-in
  `fetch`) — keeps the app's "no build step, no framework, no bundler"
  character; this is the first serverless function added to the repo.
- Reads `PRICING_MODEL_URL` and `PRICING_MODEL_API_KEY` from Netlify
  environment variables (set in the Netlify dashboard, documented in the
  README, never committed).
- On invocation: `GET {PRICING_MODEL_URL}/v1/admin/signals` with `X-API-Key`
  attached, ~5s timeout. Returns the response JSON straight through with
  `200`. On any failure (timeout, non-2xx, key/url unset), returns a `502`
  with a short error body — the caller treats any non-200 as "no snapshot"
  and proceeds without one (see Error handling).

### `netlify.toml`

Add:

```toml
[functions]
  directory = "netlify/functions"
```

## Storage

Add one nullable column to the existing `fare_entries` table — the snapshot
is captured 1:1 with each logged fare at the same moment, so a separate
table/join buys nothing:

```sql
alter table public.fare_entries add column if not exists signals_snapshot jsonb;
```

- Stores the **full raw** `/v1/admin/signals` response body as-is (calendar
  state, per-source live signals, pipeline health) — no field picking, so
  nothing here needs updating if that endpoint's shape grows later.
- `NULL` means "no snapshot" (fetch failed, or the entry predates this
  feature) — analysis code must treat `NULL` as missing, not as "no active
  signals".
- Existing RLS policies on `fare_entries` (`created_by = auth.uid()`) already
  cover the new column — no new policy needed.
- This is an additive, idempotent change to `supabase-setup.sql` (consistent
  with the rest of that file being safe to re-run). Existing Supabase
  projects need to re-run the file, or just the one `alter table` line —
  call this out in the README setup steps.

## Client changes (`index.html`)

- One snapshot per **observation**, not per tier. An observation (`cur`) is
  one pair logged at one date/time across all its configured vehicle tiers
  (`recordTier()` runs once per tier). `beginWith(p)` — where `cur` is
  initialized — kicks off `fetchSignalsSnapshot()` once and stores the
  in-flight Promise as `cur.signalsSnapshot`. Each `recordTier()` call
  attaches that same Promise reference to its row as `signals_snapshot`
  before pushing it. Because all tier rows share one Promise, only one
  network round trip happens per observation, regardless of tier count —
  awaiting an already-settled Promise multiple times does not refetch.
- `insertRow(row)` ([index.html:441](index.html#L441)) resolves whatever it
  finds in `row.signals_snapshot` before the Supabase insert: absent key ->
  fetch fresh (fallback for any row-creation path outside an observation);
  a Promise -> await it; an already-resolved value (object or `null`) ->
  use as-is. That last case covers restore/undo rows coming from `dbToRow`,
  which must never be refetched or overwritten. On any fetch failure
  (non-200, timeout, network error), the resolved value is `null` and the
  Supabase insert still happens — the fare save is never blocked by this.
- `updateRow(row)` (editing an existing entry) is unchanged — the snapshot is
  captured once, at logging time, and is not refreshed on later edits.
- `rowToDb` / `dbToRow` gain the `signals_snapshot` field (pass-through,
  no transformation needed since it's already JSON-shaped).

## Error handling & UI feedback

- The signals fetch is best-effort and never blocks or fails the fare save,
  matching the existing pattern in `pricingModel.service.js` (`ziporide-api`)
  of falling back gracefully when the pricing model is unreachable.
  Timeout: 5s.
- On failure, the row still saves and shows the normal green "synced" state
  (`setSync('ok')`) for the save itself — a failed signals fetch is not a
  save error. Surface it as a brief non-blocking notice via the existing
  `flash()` toast (e.g. "Saved — signals unavailable") rather than the
  sync-dot's error state, so it doesn't read as "your fare wasn't logged."

## Out of scope

- No background/scheduled polling of signals independent of manual entries
  (explicitly not wanted).
- No storage of the Zipo Pricing Model's own computed price/dynamic
  component — only the raw signal snapshot.
- No new scoped/lower-privilege API key on the pricing model API — reuses
  the existing `ADMIN_API_KEY`, proxied server-side.
