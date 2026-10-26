// Weekly schedule grid for the listener "Spored" view (issue #2 section A).
// Builds the next seven REAL calendar days from station.json's schedule --
// the same data the scheduler itself runs on, so the page can never show a
// lineup the station isn't actually following. No invented entries: an empty
// day is an empty day, and the client renders that honestly. Since Paket C1
// (Val 22), a date in schedule.dates replaces that date's weekday template
// (an empty override is a deliberate dark day) -- each rendered day resolves
// through effectiveDayLineup, the one precedence rule every scheduler
// day-walk shares, so the page and the playout engine can never disagree
// about what airs on an override date.
//
// Marks are template-relative (where the weekly lineup says "on air" /
// "next" at this instant) -- the REAL on-air truth is /api/now-playing's,
// which follows actual directed playback. The grid intentionally does not
// pretend to know about live overruns; the client labels the marks as
// schedule positions, not playback guarantees.
import { config } from '../config/index.js';
import { isValidTimeZone, toLocalISOString } from '../lib/time.js';
import {
  loadDowntime,
  loadDateOverrides,
  effectiveDayLineup,
  mostRecentOccurrence,
  nextOccurrence,
  nextOccurrences,
  timeToMinutes,
  weekdayKey,
  dateKey,
} from '../scheduler/scheduleUtil.js';
import { resolveShowInfo } from './showName.js';

export function stationTimeZone() {
  const configured = config.weather?.timezone;
  if (isValidTimeZone(configured)) return configured;
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone ?? 'UTC';
  } catch {
    return 'UTC';
  }
}

function showEntry(show) {
  // Display name/host resolve through the show's markdown brief exactly like
  // nowPlaying.js/upcoming.js do -- the grid never invents a title from the
  // raw id when a real one exists.
  const { name, host } = resolveShowInfo(show, show.specialTitle ?? show.id);
  return {
    id: show.id,
    name: name ?? show.id,
    host: host ?? '',
    startTime: show.startTime,
    durationMinutes: show.durationMinutes ?? null,
  };
}

// `schedule` is loadSchedule()'s output (weekday-keyed), `now` a Date in the
// station's local clock -- same calling convention as scheduleUtil's own
// helpers, so the grid and the scheduler can never disagree about "today".
export function buildWeeklyGrid(schedule, now = new Date()) {
  const current = mostRecentOccurrence(schedule, now);
  // "On air" per the template: the most recently started occurrence, but only
  // while its nominal window (start .. start+duration) still covers now. A
  // show whose slot ended is NOT marked -- filler airing past a slot end is
  // normal and the grid must not claim otherwise. Keys are DATE-scoped
  // (dateKey@timeKey), not weekday-scoped: an overnight show that spilled
  // past midnight belongs to YESTERDAY's date, and a weekday-only key would
  // otherwise light up NEXT week's cell of the same weekday instead.
  let onAirKey = null;
  if (current) {
    const duration = current.show.durationMinutes ?? 0;
    const withinSlot = now.getHours() * 60 + now.getMinutes() - current.start < duration;
    if (duration > 0 && withinSlot) onAirKey = `${current.date}@${current.timeKey}`;
  }

  let nextKey = null;
  let nextShow = null;
  if (current) {
    const next = nextOccurrence(schedule, current);
    if (next) {
      nextKey = `${next.date}@${next.timeKey}`;
      nextShow = { ...showEntry(next.show), weekday: next.weekday, date: next.date, hasGap: next.hasGap };
    }
  } else {
    // Completely empty "recent" side (e.g. fresh deploy mid-downtime): fall
    // back to the next upcoming occurrence wherever it is.
    const [upcoming] = nextOccurrences(schedule, now, 1);
    if (upcoming) {
      nextKey = `${upcoming.date}@${upcoming.timeKey}`;
      nextShow = { ...showEntry(upcoming.show), weekday: upcoming.weekday, date: upcoming.date, hasGap: false };
    }
  }

  const days = [];
  const dayCursor = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  // Paket C1 (Val 22): one read, one truth -- the walkers above resolve the
  // same overrides through their own loadDateOverrides() default parameter
  // (no signature change needed there). Each rendered day is the EFFECTIVE
  // lineup for its calendar date: an override replaces the weekday template
  // entirely, an empty override is a deliberate dark day, and every other
  // date falls back to its weekday's template exactly as before.
  const dates = loadDateOverrides();
  for (let i = 0; i < 7; i++) {
    const weekday = weekdayKey(dayCursor);
    const date = dateKey(dayCursor);
    const shows = [...effectiveDayLineup(schedule, dates, date)]
      .sort((a, b) => timeToMinutes(a.startTime) - timeToMinutes(b.startTime))
      .map((show) => {
        const entry = showEntry(show);
        const key = `${date}@${entry.startTime.replace(':', '-')}`;
        if (key === onAirKey) entry.mark = 'on-air';
        else if (key === nextKey) entry.mark = 'next';
        return entry;
      });
    // Additive per-day flag (unknown fields are ignored by existing
    // clients): true ONLY on dates that actually carry an override --
    // including deliberate dark days, so the listener page can say "poseben
    // program" on a day whose lineup is not the weekday template.
    days.push(dates[date] !== undefined ? { weekday, date, dateOverride: true, shows } : { weekday, date, shows });
    dayCursor.setDate(dayCursor.getDate() + 1);
  }

  return {
    generatedAt: toLocalISOString(now),
    timezone: stationTimeZone(),
    downtime: loadDowntime(),
    currentShow: current ? { ...showEntry(current.show), weekday: current.weekday, date: current.date } : null,
    nextShow,
    days,
  };
}
