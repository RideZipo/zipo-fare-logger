#!/usr/bin/env node
// ---------------------------------------------------------------------------
// Zipo Fare Logger — historical weather backfill
// ---------------------------------------------------------------------------
// Fills `signals_weather` on every fare_entries row where it is currently NULL,
// using Open-Meteo's historical-forecast API, in the same shape the live
// capture writes (rain_mm / temp_c / wind_ms — see stripComputed() in
// netlify/functions/signals-proxy.js).
//
// Rows carry NULL weather for two reasons: they predate the signals feature
// (added 2026-07-20), or they were logged while the PM1 bug was live, which
// filtered out any zone the pricing model didn't deem "significant" — and
// weather's gate is demand_pressure > 0, i.e. NULL on every ordinary
// fair-weather day.
//
// Backfilled blobs carry `_source` and `_backfilled_at`; live-captured ones
// have neither, so the two are always separable at analysis time.
//
//   SUPABASE_SERVICE_ROLE_KEY=... node scripts/backfill-weather.mjs --dry-run
//   SUPABASE_SERVICE_ROLE_KEY=... node scripts/backfill-weather.mjs
//
// Run scripts/fix-observation-times.mjs FIRST. This script reads each row's
// hour from obs_date+obs_time, so any row whose stored time is wrong gets the
// wrong hour's weather; that script repairs those rows, and the mismatch report
// at the end of this one is how you confirm none are left.
//
// Requires (see README):
//   grant select, update on public.fare_entries to service_role;
// ---------------------------------------------------------------------------

import { requireKey, SUPABASE_URL, selectAll, patchRow, mapConcurrent } from './lib/supabase.mjs';
import { observationInstant, driftHours } from './lib/london-time.mjs';

const TABLE = 'fare_entries';
const PROVENANCE_SOURCE = 'open-meteo-historical-forecast';
const WEATHER_API = 'https://historical-forecast-api.open-meteo.com/v1/forecast';

const LOCATIONS_PER_REQUEST = 25; // keep Open-Meteo URLs a sane length
const CONCURRENCY = 8;
const MISMATCH_WARN_HOURS = 2;

const args = process.argv.slice(2);
const DRY_RUN = args.includes('--dry-run');
const LIMIT = (() => {
  const i = args.indexOf('--limit');
  return i >= 0 && args[i + 1] ? Number(args[i + 1]) : Infinity;
})();

// ---------------------------------------------------------------------------
// Open-Meteo
// ---------------------------------------------------------------------------

const isoDay = (d) => d.toISOString().slice(0, 10);
const isoHour = (d) => `${d.toISOString().slice(0, 13)}:00`; // matches Open-Meteo's "YYYY-MM-DDTHH:00"
const floorHour = (d) => new Date(Math.floor(d.getTime() / 3600000) * 3600000);

// Open-Meteo snaps to a coarse grid (51.5074/-0.1278 comes back as 51.5/-0.25),
// so 2dp is already finer than the data — dedupe there and the whole backfill
// collapses to a handful of locations.
const locKey = (lat, lng) => `${lat.toFixed(2)},${lng.toFixed(2)}`;

async function fetchWeatherGrid(locations, startDate, endDate) {
  const byLoc = new Map(); // locKey -> Map(isoHour -> {temp_c, rain_mm, wind_ms})

  for (let i = 0; i < locations.length; i += LOCATIONS_PER_REQUEST) {
    const chunk = locations.slice(i, i + LOCATIONS_PER_REQUEST);
    const params = new URLSearchParams({
      latitude: chunk.map((l) => l.lat).join(','),
      longitude: chunk.map((l) => l.lng).join(','),
      start_date: startDate,
      end_date: endDate,
      hourly: 'temperature_2m,rain,wind_speed_10m',
      timezone: 'UTC',
      wind_speed_unit: 'ms',
    });

    const res = await fetch(`${WEATHER_API}?${params}`);
    if (!res.ok) throw new Error(`Open-Meteo failed: ${res.status} ${await res.text()}`);
    const json = await res.json();
    // Multi-location responses are an array in input order; a single location
    // comes back as a bare object.
    const results = Array.isArray(json) ? json : [json];

    results.forEach((result, idx) => {
      const hourly = result.hourly || {};
      const times = hourly.time || [];
      const hours = new Map();
      for (let h = 0; h < times.length; h++) {
        hours.set(times[h], {
          temp_c: hourly.temperature_2m[h],
          rain_mm: hourly.rain[h],
          wind_ms: hourly.wind_speed_10m[h],
        });
      }
      byLoc.set(chunk[idx].key, hours);
    });
  }

  return byLoc;
}

// Open-Meteo reports precipitation as the sum over the *preceding* hour, while
// temperature and wind are instantaneous at the label. OpenWeatherMap's
// rain.1h — what the live capture stores — is also a preceding-hour
// accumulation, so for an observation inside [T, T+1h) we read rain at T+1h and
// temp/wind at T. Getting this wrong shifts every rain figure by an hour.
function weatherAt(hours, instant) {
  const bucketStart = floorHour(instant);
  const bucketEnd = new Date(bucketStart.getTime() + 3600000);
  const atStart = hours.get(isoHour(bucketStart));
  const atEnd = hours.get(isoHour(bucketEnd));
  if (!atStart || !atEnd) return null;
  if (atStart.temp_c == null || atStart.wind_ms == null || atEnd.rain_mm == null) return null;
  return { rain_mm: atEnd.rain_mm, temp_c: atStart.temp_c, wind_ms: atStart.wind_ms };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  requireKey();
  console.log(`Supabase: ${SUPABASE_URL}${DRY_RUN ? '  (DRY RUN — nothing will be written)' : ''}`);

  const rows = await selectAll(
    TABLE,
    'id,created_at,obs_date,obs_time,origin_lat,origin_lng',
    'signals_weather=is.null&origin_lat=not.is.null&origin_lng=not.is.null&order=created_at.asc',
    LIMIT,
  );
  console.log(`Rows with NULL signals_weather and usable coordinates: ${rows.length}`);
  if (rows.length === 0) {
    console.log('Nothing to backfill.');
    return;
  }

  // Resolve every row's instant first — that fixes both the location set and
  // the date range the weather fetch needs.
  const resolved = [];
  const mismatches = [];
  let unresolved = 0;

  for (const row of rows) {
    const { instant, basis, note } = observationInstant(row);
    if (!instant || Number.isNaN(instant.getTime())) {
      unresolved++;
      continue;
    }
    // Cross-check the recorded observation time against the server-side insert
    // timestamp. Anything still flagged here should have been repaired by
    // scripts/fix-observation-times.mjs — a non-zero count means either that
    // script has not been run or a new source of drift has appeared.
    if (basis === 'obs' && row.created_at) {
      const drift = Math.abs(driftHours(instant, row.created_at));
      if (drift > MISMATCH_WARN_HOURS) {
        mismatches.push({ id: row.id, obs: `${row.obs_date} ${row.obs_time}`, created_at: row.created_at, driftH: drift.toFixed(1) });
      }
    }
    resolved.push({ row, instant, note, key: locKey(row.origin_lat, row.origin_lng) });
  }

  const locations = [...new Map(
    resolved.map((r) => [r.key, { key: r.key, lat: Number(r.row.origin_lat.toFixed(2)), lng: Number(r.row.origin_lng.toFixed(2)) }]),
  ).values()];

  // Pad the range by a day at each end: bucketEnd can spill into the next day,
  // and a London wall clock can sit on the other side of midnight UTC.
  const instants = resolved.map((r) => r.instant.getTime());
  const startDate = isoDay(new Date(Math.min(...instants) - 86400000));
  const endDate = isoDay(new Date(Math.max(...instants) + 86400000));

  console.log(`Fetching weather: ${locations.length} location(s), ${startDate} -> ${endDate}`);
  const grid = await fetchWeatherGrid(locations, startDate, endDate);

  const backfilledAt = new Date().toISOString();
  const writes = [];
  let noWeather = 0;

  for (const r of resolved) {
    const hours = grid.get(r.key);
    const w = hours ? weatherAt(hours, r.instant) : null;
    if (!w) {
      noWeather++;
      continue;
    }
    writes.push({
      id: r.row.id,
      instant: r.instant,
      note: r.note,
      weather: { ...w, _source: PROVENANCE_SOURCE, _backfilled_at: backfilledAt },
    });
  }

  if (DRY_RUN) {
    console.log('\nSample of intended writes:');
    for (const w of writes.slice(0, 10)) {
      console.log(`  ${w.id}  ${isoHour(floorHour(w.instant))}Z  ${JSON.stringify(w.weather)}${w.note ? `  [${w.note}]` : ''}`);
    }
  } else {
    // The signals_weather=is.null guard is on the write itself, not just the
    // row selection: the PATCH is a no-op against any row that has since gained
    // a value, so re-running can never overwrite a live-captured observation.
    await mapConcurrent(writes, CONCURRENCY, async (job, done) => {
      await patchRow(TABLE, job.id, { signals_weather: job.weather }, 'signals_weather=is.null');
      if (done % 250 === 0) console.log(`  ...${done}/${writes.length}`);
    });
  }

  const ambiguous = writes.filter((w) => w.note).length;

  console.log('\n--- Summary ---');
  console.log(`  scanned                 ${rows.length}`);
  console.log(`  ${DRY_RUN ? 'would fill              ' : 'filled                  '}${writes.length}`);
  console.log(`  skipped (no timestamp)  ${unresolved}`);
  console.log(`  skipped (no weather)    ${noWeather}`);
  console.log(`  clock-change edge cases ${ambiguous}`);
  console.log(`  timestamp mismatches    ${mismatches.length}`);

  if (mismatches.length) {
    console.log(`\nRows where obs_date/obs_time disagrees with created_at by >${MISMATCH_WARN_HOURS}h.`);
    console.log('These got the hour their stored observation time implies, which may be wrong —');
    console.log('run scripts/fix-observation-times.mjs to repair them:');
    for (const m of mismatches.slice(0, 20)) {
      console.log(`  ${m.id}  obs="${m.obs}" London  created_at=${m.created_at}  drift=${m.driftH}h`);
    }
    if (mismatches.length > 20) console.log(`  ...and ${mismatches.length - 20} more`);
  }
}

main().catch((err) => {
  console.error(`\nFailed: ${err.message}`);
  process.exit(1);
});
