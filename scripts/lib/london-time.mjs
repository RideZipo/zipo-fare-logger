// ---------------------------------------------------------------------------
// Europe/London <-> UTC, the single timezone authority for scripts/
// ---------------------------------------------------------------------------
// obs_date/obs_time are a London wall-clock reading — that is what
// londonDateTime() in index.html records. Anything converting in either
// direction must agree with it, so both directions live here rather than being
// reimplemented per script. Intl does the work, so BST/GMT and the two
// clock-change days need no hardcoded DST table.
// ---------------------------------------------------------------------------

const _offsetFmt = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Europe/London',
  timeZoneName: 'longOffset',
});

const _partsFmt = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Europe/London',
  hour12: false,
  year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', second: '2-digit',
});

/** London's UTC offset in minutes at a given instant (+60 during BST, 0 in GMT). */
export function londonOffsetMinutes(date) {
  const part = _offsetFmt.formatToParts(date).find((p) => p.type === 'timeZoneName');
  const m = /GMT([+-])(\d{2}):(\d{2})/.exec(part ? part.value : '');
  if (!m) return 0; // bare "GMT" — winter, offset 0
  return (m[1] === '-' ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3]));
}

/**
 * London wall clock -> UTC instant.
 * Returns { utc: Date, note: string|null }; `note` flags the two pathological
 * cases (the nonexistent hour each spring, the doubled hour each autumn)
 * rather than hiding them.
 */
export function londonWallClockToUtc(y, mo, d, h, mi, s) {
  const naive = Date.UTC(y, mo - 1, d, h, mi, s);

  // An offset guess is correct only if the instant it produces really does sit
  // at that offset. Try the offsets in force around the naive instant and keep
  // whichever self-consistently round-trip.
  const valid = new Set();
  for (const probe of [naive - 3600000, naive, naive + 3600000]) {
    const guess = londonOffsetMinutes(new Date(probe));
    const ts = naive - guess * 60000;
    if (londonOffsetMinutes(new Date(ts)) === guess) valid.add(ts);
  }

  if (valid.size === 0) {
    // Spring forward: this wall-clock time never existed. Read it as BST.
    return { utc: new Date(naive - 60 * 60000), note: 'nonexistent-local-time' };
  }

  const sorted = [...valid].sort((a, b) => a - b);
  // Autumn fall-back: the same wall clock happens twice. The earlier instant is
  // the BST one — prefer it, and say so.
  return {
    utc: new Date(sorted[0]),
    note: sorted.length > 1 ? 'ambiguous-local-time-resolved-to-BST' : null,
  };
}

/**
 * UTC instant -> London wall clock, in exactly the shape fare_entries stores:
 * { date: 'YYYY-MM-DD', time: 'HH:MM:SS' }.
 */
export function londonPartsFromUtc(date) {
  const p = Object.fromEntries(
    _partsFmt.formatToParts(date).filter((x) => x.type !== 'literal').map((x) => [x.type, x.value]),
  );
  // en-GB renders midnight as "24" in some ICU versions; normalise to "00".
  const hour = p.hour === '24' ? '00' : p.hour;
  return { date: `${p.year}-${p.month}-${p.day}`, time: `${hour}:${p.minute}:${p.second}` };
}

/**
 * A row's intended observation instant, from obs_date + obs_time read as London
 * wall clock, falling back to the server-side created_at when either is missing.
 */
export function observationInstant(row) {
  if (row.obs_date && row.obs_time) {
    const dm = /^(\d{4})-(\d{2})-(\d{2})$/.exec(row.obs_date);
    const tm = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(row.obs_time);
    if (dm && tm) {
      const { utc, note } = londonWallClockToUtc(
        Number(dm[1]), Number(dm[2]), Number(dm[3]),
        Number(tm[1]), Number(tm[2]), Number(tm[3] || 0),
      );
      return { instant: utc, basis: 'obs', note };
    }
  }
  if (row.created_at) return { instant: new Date(row.created_at), basis: 'created_at', note: null };
  return { instant: null, basis: null, note: null };
}

/** Hours between a row's stated observation time and its server insert time. */
export function driftHours(instant, createdAt) {
  return (instant.getTime() - new Date(createdAt).getTime()) / 3600000;
}
