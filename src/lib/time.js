import { config } from '../config/index.js';

// Offset-aware local-time ISO string (e.g. "2026-07-27T16:55:23.123-04:00")
// instead of Date.prototype.toISOString()'s forced UTC ("...Z") -- logs and
// history/cache records should read in the station's own local time (this
// is a single-location station; config.weather.timezone is the one place
// that's already configured, reused here as the general station timezone
// rather than duplicating the same zone string in a second config field).
// Still fully parseable by `new Date(...)` into the exact right instant (the
// numeric offset is real, not decorative), so anything doing epoch math on
// these strings (history.js's repeat-window cutoffs) is unaffected.
function tzOffsetMinutes(date, timeZone) {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
  const p = Object.fromEntries(dtf.formatToParts(date).map((x) => [x.type, x.value]));
  const asUTC = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second);
  return Math.round((asUTC - date.getTime()) / 60000);
}

// Human-readable calendar date (e.g. "Thursday, July 30, 2026") from a plain
// "YYYY-MM-DD" dateKey (scheduleUtil.dateKey()'s format) -- built straight
// from its y/m/d components via the local Date constructor, so it always
// names the same day scheduleUtil.weekdayKey() would for that same dateKey,
// with no timezone conversion to get wrong.
export function formatCalendarDate(dateKey) {
  const [y, m, d] = dateKey.split('-').map(Number);
  return new Intl.DateTimeFormat('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' }).format(
    new Date(y, m - 1, d)
  );
}

// --- Slovenian day labels (Paket B1/B2, docs/programming-research.md §5) ----
//
// The server-side Slovenian date vocabulary for SPOKEN copy. Both helpers
// build local Dates straight from the dateKey's y/m/d components (exactly
// like formatCalendarDate above), so there is no timezone conversion to get
// wrong, and the day arithmetic below is CALENDAR-day arithmetic (setDate),
// never a fixed epoch-ms step -- the fall-back-day lesson documented at
// scheduleUtil.js's addCalendarDays (a +24h step re-lands on the same
// calendar date on the 25-hour day, which would mislabel "jutri").
//
// Accusative weekday forms ("v ponedeljek", "v sredo", ...), indexed by
// Date#getDay() (0 = Sunday). Masculine inanimate days keep the nominative
// form in the accusative; the feminine ones decline (nedelja->nedeljo,
// sreda->sredo, sobota->soboto).
const SLOVENIAN_WEEKDAY_ACC = ['nedeljo', 'ponedeljek', 'torek', 'sredo', 'četrtek', 'petek', 'soboto'];

function dateFromKeyLocal(dateKey) {
  const [y, m, d] = dateKey.split('-').map(Number);
  if (!Number.isFinite(y) || !Number.isFinite(m) || !Number.isFinite(d)) return null;
  return new Date(y, m - 1, d);
}

function sameCalendarDay(a, b) {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

// "v ponedeljek" / "v sredo" ... from a plain dateKey -- the ABSOLUTE day
// phrase, correct regardless of WHEN it is spoken. This is the form promo
// clips must use (a clip lives in the pool for hours, so a relative word
// produced at 22:00 would rot after midnight; the weekday name never does).
// Returns null for an unparseable key, so callers can degrade honestly
// rather than speak a fabricated day.
export function slovenianWeekdayPhrase(dateKey) {
  const d = dateFromKeyLocal(dateKey);
  return d ? `v ${SLOVENIAN_WEEKDAY_ACC[d.getDay()]}` : null;
}

// 'danes' | 'jutri' | 'v <dneva>' -- the RELATIVE day label for a target
// dateKey, as heard from a given reference dateKey. Used by the closing
// next-show announcement (auto/liveLines.js), where the reference is the
// CURRENT show's nominal end: a show crossing midnight must label the
// morning show after it "danes", because that is what the listener hears at
// the moment the announcement airs. Beyond +1 day the phrase switches to
// the absolute weekday form (still true whenever it is spoken). Walks the
// reference forward one calendar day at a time, capped at 13 steps
// (scheduleUtil.nextOccurrences' own 14-day horizon); a target further out
// than that still gets the honest weekday phrase. Returns null when either
// key is unparseable -- never a guess.
export function slovenianDayLabel(targetKey, referenceKey) {
  const target = dateFromKeyLocal(targetKey);
  const reference = dateFromKeyLocal(referenceKey);
  if (!target || !reference) return null;
  const cursor = new Date(reference);
  for (let i = 0; i <= 13; i++) {
    if (sameCalendarDay(cursor, target)) {
      if (i === 0) return 'danes';
      if (i === 1) return 'jutri';
      break; // falls through to the weekday phrase below
    }
    cursor.setDate(cursor.getDate() + 1);
  }
  return `v ${SLOVENIAN_WEEKDAY_ACC[target.getDay()]}`;
}

// True when `timeZone` is a timezone name this Node build's ICU can actually
// use (IANA id like "Europe/Ljubljana", or a fixed offset like "UTC"). Exported
// as the ONE shared implementation -- director/weather.js's spoken time/date
// formatters and the timezone regression tests use this same copy, not their
// own (audit 2026-10-24 finding: the PR had two private copies and tests that
// re-implemented a third, so the tests never exercised production code).
export function isValidTimeZone(tz) {
  if (typeof tz !== 'string' || !tz.trim()) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

export function toLocalISOString(date = new Date(), timeZone = config.weather?.timezone) {
  if (!timeZone) return date.toISOString();
  if (!isValidTimeZone(timeZone)) {
    // Same UTC behavior as before for unparseable zones, but visible: a typo
    // like "TBD" silently shifted every log/history timestamp to UTC with
    // nothing in the logs saying so.
    console.error(
      `NOTE: invalid config.weather.timezone "${timeZone}" -- using UTC for this timestamp. ` +
        `Fix config.json to an IANA zone name (e.g. "Europe/Ljubljana").`
    );
    return date.toISOString();
  }
  const offsetMin = tzOffsetMinutes(date, timeZone);
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
  const p = Object.fromEntries(dtf.formatToParts(date).map((x) => [x.type, x.value]));
  const ms = String(date.getMilliseconds()).padStart(3, '0');
  const sign = offsetMin < 0 ? '-' : '+';
  const abs = Math.abs(offsetMin);
  const oh = String(Math.floor(abs / 60)).padStart(2, '0');
  const om = String(abs % 60).padStart(2, '0');
  return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}:${p.second}.${ms}${sign}${oh}:${om}`;
}
