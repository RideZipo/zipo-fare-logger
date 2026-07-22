#!/usr/bin/env node
// ---------------------------------------------------------------------------
// Zipo Fare Logger — repair obs_date / obs_time on rows logged before the
// timezone fix
// ---------------------------------------------------------------------------
// Before 2026-07-20 the app derived obs_date from `toISOString()` (UTC) and
// obs_time from `toTimeString()` (the *device's* local zone). For anyone
// logging from outside the UK, or across midnight, the two halves describe
// different clocks — so the stored observation time is wrong, sometimes by a
// whole day. `londonDateTime()` fixed this going forward; this script repairs
// the rows already written.
//
// Detection is the disagreement itself: compare obs_date+obs_time read as
// London wall clock against created_at, the server-side insert timestamp, and
// treat a gap of more than DRIFT_THRESHOLD_HOURS as broken. Rows are logged
// tier-by-tier within seconds of the observation, so created_at is within a
// minute or two of the real instant — which is what makes it a usable repair
// source, and what the >2h threshold keeps clear of.
//
//   SUPABASE_SERVICE_ROLE_KEY=... node scripts/fix-observation-times.mjs --dry-run
//   SUPABASE_SERVICE_ROLE_KEY=... node scripts/fix-observation-times.mjs
//
// This edits observation data, not just a derived signal column, so unlike the
// weather backfill it writes a JSON backup of every prior value BEFORE
// patching. Keep that file until you are satisfied — it is the undo.
//
// Requires (see README):
//   grant select, update on public.fare_entries to service_role;
// ---------------------------------------------------------------------------

import { writeFileSync } from 'node:fs';
import { requireKey, SUPABASE_URL, selectAll, patchRow, mapConcurrent } from './lib/supabase.mjs';
import { observationInstant, londonPartsFromUtc, driftHours } from './lib/london-time.mjs';

const TABLE = 'fare_entries';
const DRIFT_THRESHOLD_HOURS = 2;
const CONCURRENCY = 8;

const args = process.argv.slice(2);
const DRY_RUN = args.includes('--dry-run');

async function main() {
  requireKey();
  console.log(`Supabase: ${SUPABASE_URL}${DRY_RUN ? '  (DRY RUN — nothing will be written)' : ''}`);

  const rows = await selectAll(
    TABLE,
    'id,created_by,created_at,obs_date,obs_time',
    'obs_date=not.is.null&obs_time=not.is.null&created_at=not.is.null&order=created_at.asc',
  );
  console.log(`Rows with both an observation date and time: ${rows.length}`);

  // obs_date/obs_time is an OBSERVATION-level value, not a row-level one:
  // beginWith() in index.html calls londonDateTime(now) once and shares the
  // result across every vehicle tier of that observation (the data bears this
  // out — most observations are 5 rows carrying one identical timestamp, and
  // their created_at values can span nearly half an hour as the tiers are
  // logged one by one). So the repair must also be per observation: group the
  // broken rows the way the app grouped them, and give the whole group a single
  // corrected time. Repairing row-by-row from each row's own created_at would
  // fabricate a spread the app never recorded and split one observation into
  // five.
  const groups = new Map();
  for (const row of rows) {
    const { instant, basis } = observationInstant(row);
    if (!instant || basis !== 'obs' || Number.isNaN(instant.getTime())) continue;

    const drift = driftHours(instant, row.created_at);
    if (Math.abs(drift) <= DRIFT_THRESHOLD_HOURS) continue;

    const key = `${row.created_by}|${row.obs_date}|${row.obs_time}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push({ row, drift });
  }

  const broken = [];
  for (const members of groups.values()) {
    // The observation happened just before its first tier was written, so the
    // earliest created_at in the group is the closest thing to its real instant.
    const anchor = members.reduce(
      (min, m) => (new Date(m.row.created_at) < new Date(min.row.created_at) ? m : min),
      members[0],
    );
    const fixed = londonPartsFromUtc(new Date(anchor.row.created_at));

    for (const m of members) {
      broken.push({
        id: m.row.id,
        created_by: m.row.created_by,
        created_at: m.row.created_at,
        anchor_created_at: anchor.row.created_at,
        group_size: members.length,
        drift_hours: Number(m.drift.toFixed(2)),
        from: { obs_date: m.row.obs_date, obs_time: m.row.obs_time },
        to: { obs_date: fixed.date, obs_time: fixed.time },
      });
    }
  }

  console.log(
    `Rows whose stated time disagrees with created_at by >${DRIFT_THRESHOLD_HOURS}h: ` +
      `${broken.length}  (in ${groups.size} observation group(s))`,
  );
  if (broken.length === 0) {
    console.log('Nothing to repair.');
    return;
  }

  // Group by the size of the error — distinct drift values are distinct causes
  // (a fixed offset means a foreign device clock; ~24h means a date/time
  // midnight straddle), and it is worth seeing that before agreeing to write.
  const byDrift = new Map();
  for (const b of broken) {
    const k = b.drift_hours.toFixed(1);
    if (!byDrift.has(k)) byDrift.set(k, []);
    byDrift.get(k).push(b);
  }
  console.log('\nBy drift:');
  for (const [k, list] of [...byDrift].sort((a, b) => Number(a[0]) - Number(b[0]))) {
    const accts = new Set(list.map((b) => (b.created_by || '').slice(0, 8)));
    console.log(`  ${String(k).padStart(7)}h  ${String(list.length).padStart(4)} rows  account(s): ${[...accts].join(', ')}`);
  }

  // One line per observation group, since every row in a group gets the same
  // correction — that is the unit a reviewer needs to sanity-check.
  console.log('\nRepairs, one line per observation group:');
  const seen = new Set();
  for (const b of broken) {
    const key = `${b.created_by}|${b.from.obs_date}|${b.from.obs_time}`;
    if (seen.has(key)) continue;
    seen.add(key);
    console.log(
      `  ${b.from.obs_date} ${b.from.obs_time}  ->  ${b.to.obs_date} ${b.to.obs_time}` +
        `   (${b.group_size} row(s), drift ${b.drift_hours}h, account ${(b.created_by || '').slice(0, 8)})`,
    );
  }

  if (DRY_RUN) {
    console.log('\nDRY RUN — nothing written.');
    return;
  }

  // Back up before touching anything. This is observation data, not a derived
  // column: if the repair is ever judged wrong, this file is what restores it.
  const backupPath = `obs-time-backup-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
  writeFileSync(backupPath, JSON.stringify(broken, null, 2));
  console.log(`\nBackup of prior values written to ${backupPath} (keep this — it is the undo)`);

  await mapConcurrent(broken, CONCURRENCY, async (b, done) => {
    await patchRow(TABLE, b.id, { obs_date: b.to.obs_date, obs_time: b.to.obs_time });
    if (done % 25 === 0) console.log(`  ...${done}/${broken.length}`);
  });

  console.log(`\nRepaired ${broken.length} rows.`);
}

main().catch((err) => {
  console.error(`\nFailed: ${err.message}`);
  process.exit(1);
});
