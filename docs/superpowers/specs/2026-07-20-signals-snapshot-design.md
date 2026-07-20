# Signals snapshot on fare entries

Date: 2026-07-20

## Problem

The fare logger records manually-observed London taxi fares (`fare_entries`) but
has no record of what conditions the Zipo Pricing Model was seeing at the
moment each fare was logged — weather, active events, TfL disruptions, etc.
Without that, logged fares can't be correlated against the conditions that
would explain why a fare was high or low at that time.

## Goal

On every fare entry logged through the app, also capture and store the Zipo
Pricing Model's current live signals **for that entry's pickup location
only** (the H3 res-6 signal zone containing the pickup coordinate) — not a
London-wide dump, and **raw/reported values only**, not Zipo's own computed
demand scores, severities, or attendance estimates, and not a computed Zipo
price. Never block a fare save on this: it's a secondary enrichment. Store
each signal source (weather/tfl/events/sports/rail/strikes/traffic) in its
own column rather than one combined blob, so they can be queried/analysed
independently.

## Architecture

```
Browser (index.html)
  │  on beginWith() — start of a new observation, given pickup (lat, lng)
  ▼
Netlify Function: /.netlify/functions/signals-proxy?lat=..&lng=..
  │  1. GET {PRICING_MODEL_URL}/v1/pricing?lat=..&lng=..
  │     → resolve `cluster` (the H3 res-6 signal zone slug); everything
  │       else in that response (price, fees, etc.) is discarded, never stored.
  │  2. GET {PRICING_MODEL_URL}/v1/admin/signals
  │     → filter live_signals[source] down to the one entry matching `cluster`,
  │       for each of weather/tfl/events/sports/rail/strikes/traffic.
  │  header on both calls: X-API-Key: {PRICING_MODEL_API_KEY} (Netlify env vars, server-side only)
  ▼
Zipo Pricing Model API (EC2)
  → /v1/pricing resolves the H3 zone via zones/lookup.py (same res-6
    cluster_slug used as the Redis key for every signal source — see
    zones/lookup.py:18, pipeline/cache.py write_signal())
  → /v1/admin/signals reads live signals from Redis, all zones
```

The pricing model's endpoints require `X-API-Key` (the same `ADMIN_API_KEY`
used server-to-server elsewhere) or an operator Bearer JWT. This static site
has no operator-login system and cannot safely ship that key in `config.js`
the way it ships the Supabase anon key — the anon key is safe to expose by
design (RLS-gated); `ADMIN_API_KEY` is not. So the key lives only in a
Netlify Function's environment variables, never in code or the browser
bundle. This mirrors the fix already applied to the admin panel's
key-in-bundle issue.

**Why two upstream calls instead of one:** the pricing model has no
standalone "resolve zone for this coordinate" endpoint — zone resolution
(`zones/lookup.py:lookup()`) is only exposed bundled inside `/v1/pricing`,
which also computes a full price. Rather than add a new endpoint to (and
redeploy) the pricing model's production EC2 instance for this, the proxy
calls the existing `/v1/pricing` endpoint purely to read its `cluster`
field and throws the rest away. This keeps the entire change contained to
this repo, at the cost of one extra network hop per observation (still one
shared call per observation, not per tier — see below).

### New file: `netlify/functions/signals-proxy.js`

- Node runtime, no dependencies (uses the Netlify Node runtime's built-in
  `fetch`) — keeps the app's "no build step, no framework, no bundler"
  character; this is the first serverless function added to the repo.
- Reads `PRICING_MODEL_URL` and `PRICING_MODEL_API_KEY` from Netlify
  environment variables (set in the Netlify dashboard, documented in the
  README, never committed).
- Requires `lat`/`lng` query params (400 if missing). Resolves the zone via
  `/v1/pricing`, fetches `/v1/admin/signals`, filters to that zone, strips
  each source's payload down to raw/reported fields only via
  `stripComputed()` (dropping Zipo's own computed scores — see table below),
  and returns `{ cluster_slug, cluster_name, weather, tfl, events, sports,
  rail, strikes, traffic }` (`null` per source if that zone had no active
  signal there) with `200`. ~3.5s timeout per upstream call. On any failure
  (timeout, non-2xx, key/url unset), returns a `502` with a short error body
  — the caller treats any non-200 as "no snapshot" and proceeds without one
  (see Error handling).

  | Source | Raw (kept) | Computed (dropped) |
  |---|---|---|
  | weather | `rain_mm`, `temp_c`, `wind_ms` | `demand_pressure` |
  | tfl | `affected_lines` | `disruption_score`, `hex_scores` |
  | events | `events[].title/category/venue/start_iso/end_iso` | `total_attendance`, `event_count`, `events[].attendance` (estimated, not measured) |
  | sports | `fixtures[].title/venue/start_iso/end_iso/source` | `total_attendance`, `fixture_count`, `fixtures[].attendance` (estimated) |
  | strikes | `active`, `struck_lines`, `description` | `severity`, `hex_scores` |
  | traffic | `disruptions[].severity/category/comment` | `congestion_score`, `disruption_count` |
  | rail | `summary` | `disruption_score` |

  This allowlist is hand-derived from the pipeline source modules in
  `Zipo-Pricing-Model` (`pipeline/sources/*.py`, `pipeline/listeners/rail.py`)
  as of 2026-07-20 and will drift silently if those modules' payload shapes
  change — there's no schema contract enforcing it. Whoever changes a
  pipeline source's `value`/payload shape should check `stripComputed()`.

### `netlify.toml`

Add:

```toml
[functions]
  directory = "netlify/functions"
```

## Storage

Add seven nullable columns to the existing `fare_entries` table, one per
signal source — the snapshot is captured 1:1 with each logged fare at the
same moment, so a separate table/join buys nothing, and per-source columns
(rather than one combined blob) let each source be queried/analysed on its
own:

```sql
alter table public.fare_entries add column if not exists signals_weather jsonb;
alter table public.fare_entries add column if not exists signals_tfl jsonb;
alter table public.fare_entries add column if not exists signals_events jsonb;
alter table public.fare_entries add column if not exists signals_sports jsonb;
alter table public.fare_entries add column if not exists signals_rail jsonb;
alter table public.fare_entries add column if not exists signals_strikes jsonb;
alter table public.fare_entries add column if not exists signals_traffic jsonb;
```

- Each column stores that source's `data` object for the entry's pickup
  zone, exactly as returned by the pricing model (no reshaping) — nothing
  here needs updating if a source's data shape grows later.
- Deliberately **not stored**: `cluster_slug`/`cluster_name` (re-derivable
  any time from `origin_lat`/`origin_lng` via the same zone lookup, so
  storing it would be redundant) and calendar/pipeline-health data (not
  per-zone, out of scope — see "Out of scope").
- `NULL` in any column means either no snapshot was captured for the row at
  all (fetch failed, or the row predates these columns) or that source had
  no active signal in this entry's zone — the two aren't distinguished;
  re-derive the pickup zone to check which, if that distinction matters.
- Existing RLS policies on `fare_entries` (`created_by = auth.uid()`) already
  cover the new columns — no new policy needed.
- This is an additive, idempotent change to `supabase-setup.sql` (consistent
  with the rest of that file being safe to re-run), and also drops the
  earlier single-blob `signals_snapshot` column from an unshipped prior
  iteration of this feature if present. Existing Supabase projects need to
  re-run the file, or just the `alter table` lines — call this out in the
  README setup steps.

## Client changes (`index.html`)

- One snapshot per **observation**, not per tier. An observation (`cur`) is
  one pair logged at one date/time across all its configured vehicle tiers
  (`recordTier()` runs once per tier). `beginWith(p)` — where `cur` is
  initialized — kicks off `fetchSignalsSnapshot(p.olat, p.olng)` (the pair's
  pickup coordinate) once and stores the in-flight Promise as
  `cur.signalsSnapshot`. Each `recordTier()` call attaches that same Promise
  reference to its row as an internal `_signals` field before pushing it.
  Because all tier rows share one Promise, only one network round trip
  (which is itself two upstream calls, see Architecture) happens per
  observation, regardless of tier count — awaiting an already-settled
  Promise multiple times does not refetch.
- `insertRow(row)` ([index.html:441](index.html#L441)) resolves whatever it
  finds in `row._signals` before the Supabase insert: absent key -> treat as
  no snapshot (`null`); a Promise -> await it; an already-resolved value
  (object or `null`) -> use as-is. That last case covers restore/undo rows
  coming from `dbToRow`, which must never be refetched or overwritten. On
  any fetch failure (non-200, timeout, network error, or missing
  coordinates), the resolved value is `null` and the Supabase insert still
  happens — the fare save is never blocked by this.
- `rowToDb(row)` reads the resolved `row._signals` object and maps its
  `weather`/`tfl`/`events`/`sports`/`rail`/`strikes`/`traffic` fields onto
  the 7 `signals_*` DB columns (each `?? null` if absent). `_signals` itself
  is an internal in-memory field only — it is never a DB column name.
- `dbToRow(d)` does the inverse: reassembles the 7 flat `signals_*` DB
  columns back into one `_signals` object on load, so restore/undo/edit
  paths always see a single resolved value, never a Promise.
- `updateRow(row)` (editing an existing entry) is unchanged — the snapshot is
  captured once, at logging time, and is not refreshed on later edits.

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
  component — only the raw per-zone signal data.
- No new scoped/lower-privilege API key on the pricing model API — reuses
  the existing `ADMIN_API_KEY`, proxied server-side.
- No new "resolve zone for a coordinate" endpoint added to the pricing
  model API — reuses `/v1/pricing`'s `cluster` field instead, to avoid
  touching/redeploying that production backend for this change (see
  Architecture). Worth revisiting if the extra hop's latency becomes a
  problem.
- Not scoped to the dropoff location, only pickup — a route can cross
  zones, but pickup-zone signals are treated as the relevant ones for this
  feature, consistent with how the pricing model treats the pickup zone as
  primary in its own origin-only pricing mode.
- Calendar signals (bank holiday, school holiday, active events with
  citywide/curated attendance data — distinct from the per-zone `events`
  signal source) and pipeline health are not captured — they're either not
  zone-scoped or not signal data, so they fall outside "signals that affect
  the hexagon."
