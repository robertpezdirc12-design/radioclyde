// Shared day/time/path math for the weekly scheduler -- station.json holds
// both the weekly lineup (under "schedule", weekday-keyed: {monday: [...],
// ...}, each entry {id, startTime, durationMinutes, description}) and the
// station's personality (under "station": name, filler branding, etc.) --
// config.json stays limited to core/operational settings. Schedule keys may
// also be comma-separated lists of weekdays sharing one lineup
// ({"monday,tuesday,wednesday": [...]}), expanded by loadSchedule().
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config/index.js';
import { createLogger } from '../lib/logger.js';
import { resolveSpecialTheme, themedBriefRelPath } from '../auto/showCatalog.js';

const log = createLogger('station');

const WEEKDAY_KEYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];

// Fail-open read: a missing or corrupt station.json must not 500 every
// /api/now-playing, /api/schedule, /api/upcoming poll on a half-configured
// deploy (Fastify's default error body also leaks absolute paths). Every
// consumer of this file already treats "no schedule/station/downtime block"
// as a supported state -- loadSchedule() ?? {}, loadStation() ?? {},
// [state.weekday] of {} is undefined -- so an empty object here is exactly
// the shape a fresh install with no station.json yet produces. A valid file
// behaves byte-identically to the bare JSON.parse this replaced.
function readStationFile() {
  try {
    return JSON.parse(fs.readFileSync(config.paths.stationFile, 'utf8'));
  } catch {
    return {};
  }
}

// P4 #18: a schedule entry carrying a `special` block ({ themes: [...],
// personas: [...] }) is the weekly themed slot (see auto/showCatalog.js).
// It gets resolved here against the CURRENT week so every reader (scheduler,
// grid, now-playing, upcoming) sees one concrete show: a `description`
// pointing at the generated brief, the resolved `specialTheme`/`specialTitle`
// for display. The raw `special` block is PRESERVED on the resolved entry --
// generateScript.js re-resolves it against the TRUE occurrence date (the one
// case where the two disagree: a Sunday-night prewarm of a Monday 00:00 slot
// sits in the previous ISO week, but airs in the new one). A misconfigured
// special must not take the whole schedule read down with it: it's passed
// through raw and production throws the same message later, where the
// failure actually has a show/slot name attached to it.
function resolveSpecialOccurrence(show) {
  try {
    const theme = resolveSpecialTheme(show.special, new Date());
    return {
      ...show,
      description: themedBriefRelPath(theme.id),
      specialTheme: theme.id,
      specialTitle: theme.title,
    };
  } catch (err) {
    log(`special slot "${show.id}" is not resolvable (${err.message}) -- passed through raw; production will fail with the same message.`);
    return show;
  }
}

// Keys may be a single weekday ("monday") or a comma-separated list
// ("monday,tuesday,wednesday") sharing the same lineup; expand those here so
// every caller downstream just sees plain per-weekday keys.
export function loadSchedule() {
  const raw = readStationFile().schedule ?? {};
  const schedule = {};
  for (const [key, shows] of Object.entries(raw)) {
    for (const day of key.split(',').map((d) => d.trim())) {
      schedule[day] = shows.map((show) => (show.special ? resolveSpecialOccurrence(show) : show));
    }
  }
  return schedule;
}

// The station's personality block: { name, filler: { excludeKeywords } }.
export function loadStation() {
  return readStationFile().station ?? {};
}

// Station-wide bans applied to every show queue AND filler. neverPlay is
// the source of truth once present; older station.json files only had
// filler.excludeKeywords, which still apply until neverPlay is saved.
export function loadNeverPlay() {
  const station = loadStation();
  if (station.neverPlay) {
    return {
      keywords: [...(station.neverPlay.keywords ?? [])],
      artists: [...(station.neverPlay.artists ?? [])],
    };
  }
  return {
    keywords: [...(station.filler?.excludeKeywords ?? [])],
    artists: [],
  };
}

// The station's downtime window: { start: "HH:MM", end: "HH:MM" }, the
// stretch of each day (e.g. "00:00"-"07:00") where nothing airs and filler
// plays -- see station.json. Optional: a station with none configured keeps
// every show on its own scriptLeadTimeMinutes/directLeadTimeMinutes
// near-air-time schedule, exactly as before this existed.
export function loadDowntime() {
  return readStationFile().downtime ?? null;
}

// True if `now`'s time-of-day falls inside the downtime window. A window
// that wraps midnight (start "23:00", end "06:00") and one that doesn't
// (start "00:00", end "07:00") are both just "start <= now" OR'd with "now <
// end" -- the wrap only changes which side of that OR ends up doing the
// work, so one comparison covers both.
export function isDowntime(downtime, now) {
  if (!downtime) return false;
  const start = timeToMinutes(downtime.start);
  const end = timeToMinutes(downtime.end);
  if (start === end) return false; // zero-length window -- treat as unconfigured
  const nowMinutes = now.getHours() * 60 + now.getMinutes();
  return start < end ? nowMinutes >= start && nowMinutes < end : nowMinutes >= start || nowMinutes < end;
}

// Minutes from `now` until the downtime window next *starts* -- i.e. how far
// ahead scheduleScripts.js/schedulePrewarmAudio.js can widen their horizon to
// front-load "the rest of today's broadcast day" in one pass when called
// from inside the window, and the same span scheduleWatch.js's invalidation
// sweep needs when called from outside it, since a station.json edit made
// during the day can still land on something that was preprocessed as far
// back as last night's downtime run.
export function minutesUntilNextDowntimeStart(downtime, now) {
  const start = timeToMinutes(downtime.start);
  const nowMinutes = now.getHours() * 60 + now.getMinutes();
  const diff = start - nowMinutes;
  return diff <= 0 ? diff + 24 * 60 : diff;
}

export function weekdayKey(date) {
  return WEEKDAY_KEYS[date.getDay()];
}

function pad2(n) {
  return String(n).padStart(2, '0');
}

export function dateKey(date) {
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
}

export function timeKey(startTime) {
  return startTime.replace(':', '-');
}

export function dateDir(weekday, showId, date) {
  return path.join(config.paths.runningDir, weekday, showId, date);
}

export function occurrenceDir(weekday, showId, date, time) {
  return path.join(dateDir(weekday, showId, date), time);
}

// Where a real occurrence (a specific weekday/showId/date/time, not just the
// weekly template slot) actually stands: 'directed' once playlist.m3u exists
// (director/index.js writes it last, so its presence alone means ready to
// air), 'script' once script.md exists but it isn't directed yet, 'none'
// before either exists. Same two fs.existsSync checks scheduler.js's
// logStartupStatus() used inline before this was pulled out, now also used
// by the studio schedule API to show readiness on the grid.
export function occurrenceReadiness(weekday, showId, date, time) {
  if (fs.existsSync(path.join(occurrenceDir(weekday, showId, date, time), 'playlist.m3u'))) return 'directed';
  if (fs.existsSync(path.join(dateDir(weekday, showId, date), 'script.md'))) return 'script';
  return 'none';
}

export function timeToMinutes(startTime) {
  const [h, m] = startTime.split(':').map(Number);
  return h * 60 + m;
}

function dateFromKey(date) {
  const [y, m, d] = date.split('-').map(Number);
  return new Date(y, m - 1, d);
}

// Calendar-day arithmetic, NOT epoch-ms steps: adding/subtracting a fixed
// 24*60*60*1000 is only "one day" when no DST transition intervenes. On the
// 25-hour fall-back day (Europe/Ljubljana 2026-10-25, 03:00 CEST -> 02:00
// CET) a +24h walk from local midnight re-lands on the SAME calendar date
// (00:00 CEST + 24h = 23:00 CET) -- verified live: nextOccurrence's day walk
// then re-selected the already-aired Sunday lineup (shows[0]), hasGap was
// false, and updateNowPlaying reloaded the morning show as "next" all
// night, state.date re-anchoring on every replay so the loop never ended.
// setDate() moves the LOCAL calendar day in every timezone (including
// half-hour offsets); a spring-forward 23-hour day lands correctly too (the
// epoch step overshot into 01:00 of the next day, the calendar step lands
// on its midnight). Shared by every day-walk in this file and by
// scheduleDirect.js's yesterday sweep so the convention lives in one place.
export function addCalendarDays(date, days) {
  const d = new Date(date);
  d.setDate(d.getDate() + days);
  return d;
}

// Absolute epoch ms for a schedule entry's nominal start, given the dateKey()
// it airs on -- lets gap detection compare two occurrences that may fall on
// different calendar days (a day's last show followed by tomorrow's first)
// on one consistent timeline instead of separate per-day minute-of-day math.
// Exported since Paket B1: auto/liveLines.js computes the CURRENT show's
// nominal end (absoluteStart + durationMinutes) as the reference point for
// the "danes/jutri" day label of the next-show announcement -- a show that
// crosses midnight must announce tomorrow's morning show as "danes", because
// that is what the listener hears at the moment the announcement airs.
export function absoluteStart(date, startTime) {
  const d = dateFromKey(date);
  const [h, m] = startTime.split(':').map(Number);
  d.setHours(h, m, 0, 0);
  return d.getTime();
}

// True once a show/date's dj-audio has been fully synthesized by the
// downtime prewarm pass (schedulePrewarmAudio.js writes this marker only
// after every cached segment succeeds) -- confirmed live 2026-08-07: a show
// in this state directs in under a second (every dj line is a cache hit;
// only genuine `live` weather/time segments still need fresh synthesis),
// completely unlike the minutes-per-line cost minLeadTimeMinutes is sized
// for. Read-only file check, cheap enough to call on every lead-time check.
export function isDjAudioPrewarmed(weekday, showId, date) {
  return fs.existsSync(path.join(dateDir(weekday, showId, date), 'dj-audio', '.prewarmed'));
}

// True once fewer than config.schedule.minLeadTimeMinutes remain before an
// occurrence's scheduled start. Producing a show (script + TTS, end to end)
// reliably takes at least that long, so starting work with less runway than
// that can only ever finish late -- there's no "window" to still catch, only
// a slot that's better left to filler. This is a forward-looking floor, not
// just "has it already aired": a show still 20 minutes out is exactly as
// unproducible-in-time as one that aired an hour ago. Checked both when
// first deciding whether an occurrence is worth queuing, and again right as
// a queued job comes off the queue -- a busy queue can itself eat enough of
// that runway that a show worth starting when queued no longer is by the
// time it's its turn.
//
// Bypassed entirely when the show's dj-audio is already fully prewarmed
// (see isDjAudioPrewarmed) -- confirmed live 2026-08-07: two shows with
// stale/near-zero runway (country, ed-sheeran) both directed in under a
// second once prewarmed, because minLeadTimeMinutes budgets for TTS
// synthesis that, in the prewarmed case, never happens. Without this, a
// fully-ready show past its runway floor gets skipped forever even though
// directing it is instant -- the exact failure that left the station on
// filler on 2026-08-07 while several complete shows sat unused.
export function hasLeadTime(date, show, now, weekday) {
  if (weekday && isDjAudioPrewarmed(weekday, show.id, date)) return true;
  // ?. on the whole block: scheduleUtil is imported by every web route that
  // reads the schedule, so a hand-edited config without a schedule block must
  // not turn each poll into a TypeError (same F2 class scheduler.js's cadence
  // knobs guard against).
  const minLeadTimeMs = (config.schedule?.minLeadTimeMinutes ?? 30) * 60 * 1000;
  return absoluteStart(date, show.startTime) - now.getTime() >= minLeadTimeMs;
}

// Same idea as hasLeadTime, but for script production, which is keyed per
// show/day rather than per occurrence -- a same-day repeat (e.g. Elvis at
// 10am and 2pm) shares one script.md, so it's still worth producing as long
// as ANY of today's occurrences still has enough runway, even if the
// specific occurrence that triggered this particular check no longer does.
export function anyOccurrenceHasLeadTime(schedule, weekday, showId, date, now) {
  const todays = (schedule[weekday] ?? []).filter((s) => s.id === showId);
  return todays.some((s) => hasLeadTime(date, s, now, weekday));
}

function sortedDayShows(schedule, weekday) {
  return [...(schedule[weekday] ?? [])].sort(
    (a, b) => timeToMinutes(a.startTime) - timeToMinutes(b.startTime)
  );
}

// The occurrence that should be loaded right now: the one with the latest
// startTime that isn't in the future. No upper bound from durationMinutes --
// a show's real on-air runtime (DJ speech + track lengths) routinely differs
// from its scheduled slot, so scheduler/updateNowPlaying.js is the one that
// decides, from the *actual* directed duration, when it's safe to cut to
// whatever this returns next; this just answers "what's the most recently-
// started show." Checks today's AND yesterday's schedule (yesterday's
// entries shifted back by a full day) so a show starting late (e.g. 23:30,
// 90min) that's still running past midnight is found correctly -- a real
// weekly schedule (unlike the old single-repeating showday.json template)
// means today's and yesterday's lineups can differ.
export function mostRecentOccurrence(schedule, now) {
  const nowMinutes = now.getHours() * 60 + now.getMinutes();
  // Yesterday via addCalendarDays, never a -24h epoch step: on the fall-back
  // day's last local hour (23:xx CET = 24+ real hours since midnight) a -24h
  // step re-lands on the SAME date, so Saturday's late-night spill would be
  // missed exactly when it matters (a show still airing past 23:00).
  const candidates = [
    { day: now, offset: 0 },
    { day: addCalendarDays(now, -1), offset: -1440 },
  ];
  let best = null;
  for (const { day, offset } of candidates) {
    const weekday = weekdayKey(day);
    const date = dateKey(day);
    for (const show of schedule[weekday] ?? []) {
      const start = timeToMinutes(show.startTime) + offset;
      if (start <= nowMinutes && (!best || start > best.start)) {
        best = { show, weekday, date, timeKey: timeKey(show.startTime), start };
      }
    }
  }
  // `start` (minute-of-day, offset-aware -- yesterday's spill carries
  // -1440) is part of the return so callers can tell whether the occurrence
  // is still inside its nominal slot; scheduleGrid.js's on-air marking
  // depends on it, and the field is additive for every existing consumer.
  return best && { show: best.show, weekday: best.weekday, date: best.date, timeKey: best.timeKey, start: best.start };
}

// Every occurrence starting within horizonMinutes from now, checking today's
// AND tomorrow's schedule (tomorrow's entries shifted forward a full day) --
// replaces the old minutesUntilNext mod-1440 trick, which only worked
// because showday.json was the same lineup every day.
export function upcomingOccurrences(schedule, now, horizonMinutes) {
  const nowMinutes = now.getHours() * 60 + now.getMinutes();
  const results = [];
  // Tomorrow via addCalendarDays for the same DST reason as the -24h case
  // above, mirrored: on the fall-back day's first local hour (00:xx CEST) a
  // +24h step re-lands on the SAME date at 23:xx, so tomorrow's lineup would
  // be missed and today's shows would appear twice (offset 0 AND +1440).
  const candidates = [
    { day: now, offset: 0 },
    { day: addCalendarDays(now, 1), offset: 1440 },
  ];
  for (const { day, offset } of candidates) {
    const weekday = weekdayKey(day);
    const date = dateKey(day);
    for (const show of schedule[weekday] ?? []) {
      const start = timeToMinutes(show.startTime) + offset;
      const minutesUntil = start - nowMinutes;
      if (minutesUntil >= 0 && minutesUntil <= horizonMinutes) {
        results.push({ show, weekday, date, timeKey: timeKey(show.startTime), minutesUntil });
      }
    }
  }
  return results;
}

// The next `count` occurrences from now, regardless of how many days out
// that spans -- unlike upcomingOccurrences (fixed today/tomorrow horizon,
// used by the scheduler's own lead-time checks), this is for the web page's
// "coming up" list, where the right answer is always exactly N shows, not
// "however many happen to fall in the next X minutes." Walks forward day by
// day, capped at 14 days so a schedule with entirely dark days (or an empty
// schedule) can't loop forever.
export function nextOccurrences(schedule, now, count) {
  const nowMinutes = now.getHours() * 60 + now.getMinutes();
  const results = [];
  let day = new Date(now);
  for (let daysChecked = 0; results.length < count && daysChecked < 14; daysChecked++) {
    const weekday = weekdayKey(day);
    const date = dateKey(day);
    for (const show of sortedDayShows(schedule, weekday)) {
      if (daysChecked === 0 && timeToMinutes(show.startTime) < nowMinutes) continue;
      results.push({ show, weekday, date, timeKey: timeKey(show.startTime) });
      if (results.length >= count) break;
    }
    // Calendar-day step (see addCalendarDays): an epoch +24h walk re-visits
    // the fall-back day itself (same date at 23:xx), duplicating today's
    // entries in the "coming up" list and hiding the next day's early shows.
    day = addCalendarDays(day, 1);
  }
  return results;
}

// The occurrence that comes right after `current` in station.json's ordered
// lineup -- as distinct from mostRecentOccurrence, which re-derives "what's
// due now" from wall-clock and so keeps re-selecting the show that just
// finished until the clock catches up to the next slot's nominal start. This
// is what lets scheduler/updateNowPlaying.js cut over the instant a show's
// real (directed) runtime ends, on a schedule with no gaps, instead of
// leaving filler running until the next scheduled startTime arrives. Returns
// null only if there's truly nothing programmed for any day (station.json
// has an empty schedule). `hasGap` is true when station.json itself leaves a
// stretch uncovered (next's nominal start is later than current's nominal
// end) -- the one case filler is meant to fill deliberately, so the caller
// should wait for wall-clock to reach `nextStart` rather than cutting over
// immediately.
export function nextOccurrence(schedule, current) {
  const { show: currentShow, weekday, date, timeKey: currentTimeKey } = current;
  const todays = sortedDayShows(schedule, weekday);
  const idx = todays.findIndex((s) => timeKey(s.startTime) === currentTimeKey);

  let next, nextWeekday, nextDate;
  if (idx !== -1 && idx + 1 < todays.length) {
    next = todays[idx + 1];
    nextWeekday = weekday;
    nextDate = date;
  } else {
    // Walk forward day by day (rather than assuming tomorrow always has a
    // lineup) so a schedule with an entirely dark day in between still finds
    // the next real occurrence instead of returning null too early. Calendar
    // step via addCalendarDays -- the +24h epoch step this used to be is the
    // fall-back-day bug: it re-landed on the SAME Sunday, picked shows[0]
    // (the already-aired morning show) and looped the replay all night.
    let day = addCalendarDays(dateFromKey(date), 1);
    for (let i = 0; i < 7; i++) {
      const wd = weekdayKey(day);
      const shows = sortedDayShows(schedule, wd);
      if (shows.length > 0) {
        next = shows[0];
        nextWeekday = wd;
        nextDate = dateKey(day);
        break;
      }
      day = addCalendarDays(day, 1);
    }
    if (!next) return null;
  }

  const currentNominalEnd = absoluteStart(date, currentShow.startTime) + currentShow.durationMinutes * 60 * 1000;
  const nextStart = absoluteStart(nextDate, next.startTime);
  return {
    show: next,
    weekday: nextWeekday,
    date: nextDate,
    timeKey: timeKey(next.startTime),
    hasGap: nextStart > currentNominalEnd,
    nextStart,
  };
}
