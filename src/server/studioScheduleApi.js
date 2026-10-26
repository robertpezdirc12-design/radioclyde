// The weekly schedule grid's API -- reads via scheduleUtil.js, writes via
// stationWriter.js (which validates + locks + atomically writes
// station.json). Registered under the /studio prefix (see studioAuth.js).
import {
  loadSchedule,
  loadStation,
  loadDowntime,
  loadDateOverrides,
  effectiveDayLineup,
  addCalendarDays,
  weekdayKey,
  dateKey,
  timeKey,
  occurrenceReadiness,
} from '../scheduler/scheduleUtil.js';
import { checkScheduleChanged } from '../scheduler/scheduleWatch.js';
import {
  addOccurrence,
  updateOccurrence,
  removeOccurrence,
  updateStationMeta,
  replaceDateSchedule,
  removeDateSchedule,
} from '../scheduler/stationWriter.js';

// Runs scheduleWatch's own invalidation check inline, right after a write,
// instead of waiting for its next interval tick -- both processes are the
// same one now (src/server/index.js's process merge), so this is just a
// direct function call, not a signal to anything external. Never lets a
// write itself fail if this throws (e.g. a mid-write race with the
// scheduler's own tick) -- it'll just catch it on its next tick as before.
function invalidateSoon() {
  try {
    checkScheduleChanged();
  } catch {
    // next scheduled tick will pick it up
  }
}

export function registerStudioScheduleApi(fastify) {
  fastify.get('/api/schedule', () => ({
    schedule: loadSchedule(),
    station: loadStation(),
    downtime: loadDowntime(),
  }));

  // The weekly grid shows one recurring template slot per weekday, but
  // readiness (has a script/playlist actually been produced) only exists for
  // real calendar occurrences -- so this only ever has an answer for today's
  // and tomorrow's DATE, the two days scheduleScripts.js/scheduleDirect.js
  // can plausibly have already touched (scriptLeadTimeMinutes/
  // directLeadTimeMinutes are both well under 24h by default). Every other
  // weekday's slot has no real occurrence dir yet, so it's simply absent from
  // the response -- the studio UI treats a missing key as "not due yet"
  // rather than "not ready", which is the same distinction
  // logStartupStatus() draws for occurrences outside its own horizon.
  fastify.get('/api/schedule/readiness', () => {
    const schedule = loadSchedule();
    const dates = loadDateOverrides();
    const now = new Date();
    // Tomorrow via addCalendarDays, never a +24h epoch step: on the DST
    // fall-back day (Europe/Ljubljana 2026-10-25) epoch+24h re-lands on the
    // SAME calendar date, so "tomorrow" would have answered today's weekday
    // twice and tomorrow's real slots would have gone unanswered -- the same
    // day-walk class the scheduleUtil walkers already fixed. The key stays
    // "weekday/time": today and tomorrow are always different weekdays, so
    // it remains unambiguous.
    const tomorrow = addCalendarDays(now, 1);
    const days = [
      { weekday: weekdayKey(now), date: dateKey(now) },
      { weekday: weekdayKey(tomorrow), date: dateKey(tomorrow) },
    ];

    const readiness = {};
    for (const { weekday, date } of days) {
      // Paket C1 (Val 22): the EFFECTIVE lineup per calendar date -- an
      // override date answers readiness for its override entries, and the
      // suppressed weekday template's slots stay absent (they never get
      // produced, so "not due yet" is the honest reading for them).
      for (const show of effectiveDayLineup(schedule, dates, date)) {
        const time = timeKey(show.startTime);
        readiness[`${weekday}/${time}`] = occurrenceReadiness(weekday, show.id, date, time);
      }
    }
    return { readiness };
  });

  // Paket C1 (Val 22) -- the date-bound full-day overrides (station.json's
  // schedule.dates["YYYY-MM-DD"]): reads return the raw persisted block; the
  // writes below go through stationWriter's replaceDateSchedule/
  // removeDateSchedule (same validate + lock + atomic discipline as the
  // weekday routes further down).
  fastify.get('/api/schedule/dates', () => ({
    dates: loadDateOverrides(),
  }));

  // Full-day REPLACEMENT, never a merge: the body's occurrences array
  // becomes the entire effective lineup for that date (its weekday template
  // is suppressed for it). An empty array is a deliberate dark day --
  // filler/emergency cover it, exactly like any lineup-less weekday. The
  // response echoes what replaceDateSchedule actually placed (sorted, packed
  // back-to-back), the same convention as the weekday POST/PATCH below.
  fastify.put('/api/schedule/dates/:date', async (request, reply) => {
    try {
      const occurrences = await replaceDateSchedule(request.params.date, request.body?.occurrences);
      invalidateSoon();
      return { date: request.params.date, occurrences };
    } catch (err) {
      return reply.code(400).send({ error: err.message });
    }
  });

  // Removing an override returns that date to its weekday's weekly template.
  // 400 (not 404) when nothing is stored at that date: a nonexistent date is
  // a validation-shaped problem for this API's one-resource-per-date shape,
  // and the studio surfaces the message either way.
  fastify.delete('/api/schedule/dates/:date', async (request, reply) => {
    try {
      const removed = await removeDateSchedule(request.params.date);
      invalidateSoon();
      return removed;
    } catch (err) {
      return reply.code(400).send({ error: err.message });
    }
  });

  // addOccurrence/updateOccurrence return the whole day post-reflow (not
  // just the one changed) -- a conflicting drop pushes the rest of the day's
  // lineup later rather than being rejected, so the response reflects
  // everything that actually moved.
  fastify.post('/api/schedule/:weekday', async (request, reply) => {
    try {
      const day = await addOccurrence(request.params.weekday, request.body ?? {});
      invalidateSoon();
      return { weekday: request.params.weekday, occurrences: day };
    } catch (err) {
      return reply.code(400).send({ error: err.message });
    }
  });

  fastify.patch('/api/schedule/:weekday/:timeKey', async (request, reply) => {
    try {
      const day = await updateOccurrence(request.params.weekday, request.params.timeKey, request.body ?? {});
      invalidateSoon();
      return { weekday: request.params.weekday, occurrences: day };
    } catch (err) {
      return reply.code(400).send({ error: err.message });
    }
  });

  fastify.delete('/api/schedule/:weekday/:timeKey', async (request, reply) => {
    try {
      const removed = await removeOccurrence(request.params.weekday, request.params.timeKey);
      invalidateSoon();
      return removed;
    } catch (err) {
      return reply.code(400).send({ error: err.message });
    }
  });

  fastify.put('/api/schedule/meta', async (request, reply) => {
    try {
      const result = await updateStationMeta(request.body ?? {});
      invalidateSoon();
      return result;
    } catch (err) {
      return reply.code(400).send({ error: err.message });
    }
  });
}
