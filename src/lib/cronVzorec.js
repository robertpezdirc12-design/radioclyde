// Pure math behind the station doctor (npm run doctor) -- the cron-vzorec
// derivation from station.json plus check-result aggregation. Everything here
// is PURE: no fs, no network, no config imports, so tests run in
// microseconds and the functions can never fail on a broken environment --
// the CLI (src/cli/doctorCli.js) owns all probing.
//
// The agreed pattern (option c) is "dnevni doctor pred vsako terminirano
// uro". Cron cannot read station.json, so we derive the timetable from the
// REAL weekly schedule: every DISTINCT scheduled start time gets one crontab
// line that fires N minutes before that start. A schedule edit therefore
// updates the vzorec automatically the next time someone runs
// `npm run doctor -- --cron` and pastes the output into crontab -- no
// hand-maintained hour list anywhere.

// node:node:config exposes no weekday table of its own and the schedule keys
// are English weekday names (scheduleUtil.WEEKDAY_KEYS is not exported), so
// this mapping IS the contract between station.json and crontab's 0=Sunday
// day-of-week field. Keys lowercase here; loadSchedule() does NOT normalize
// case, so callers pass keys through toLowerCase() first.
const CRON_DOW = { sunday: 0, monday: 1, tuesday: 2, wednesday: 3, thursday: 4, friday: 5, saturday: 6 };

// Every distinct scheduled start time in the weekly lineup, with the set of
// weekdays (cron day-of-week numbers) that carry it. Comma-separated
// weekday keys ("monday,tuesday") are expanded exactly like loadSchedule()
// does; unknown or malformed entries are skipped honestly rather than
// throwing -- a typo in one key must not take down the whole vzorec.
// Returns [{ startTime: "HH:MM", dows: [..] }] sorted by startTime.
export function distinctScheduleStarts(schedule) {
  const seen = new Map();
  for (const [key, shows] of Object.entries(schedule ?? {})) {
    for (const day of String(key).split(',').map((d) => d.trim().toLowerCase())) {
      const dow = CRON_DOW[day];
      if (!Number.isInteger(dow)) continue;
      for (const show of Array.isArray(shows) ? shows : []) {
        const start = String(show?.startTime ?? '');
        if (!/^\d{2}:\d{2}$/.test(start)) continue;
        if (!seen.has(start)) seen.set(start, new Set());
        seen.get(start).add(dow);
      }
    }
  }
  return [...seen.entries()]
    .map(([startTime, dows]) => ({ startTime, dows: [...dows].sort((a, b) => a - b) }))
    .sort((a, b) => a.startTime.localeCompare(b.startTime));
}

// "HH:MM" minus `minutesBefore` minutes, as a cron hour/minute pair. The
// result may land on the PREVIOUS calendar day (a Monday 00:05 show has its
// doctor run Sunday 23:50) -- that case is reported as dayShift: -1 so the
// caller can shift the day-of-week field too, which is exactly what raw
// minute arithmetic would silently get wrong.
export function shiftedCronTime(startTime, minutesBefore) {
  const [h, m] = String(startTime).split(':').map(Number);
  if (!Number.isFinite(h) || !Number.isFinite(m)) throw new Error(`Neveljaven začetek termina: "${startTime}".`);
  const before = Number.isFinite(minutesBefore) ? Math.max(0, Math.trunc(minutesBefore)) : 15;
  let total = h * 60 + m - before;
  let dayShift = 0;
  if (total < 0) {
    total += 1440;
    dayShift = -1;
  }
  return { hour: Math.floor(total / 60), minute: total % 60, dayShift };
}

// One entry per DISTINCT doctor firing time. Two different shows can need
// the same firing time on different weekdays (Monday 20:00 and Wednesday
// 20:00 both need a 19:45 run) -- those merge into one line with dayField
// "1,3". Entries whose shifted time crosses midnight carry their
// day-of-week field already shifted back one day (see shiftedCronTime); a
// midnight-crossing union with a same-evening start still unions correctly,
// because the -1 day shift is applied BEFORE the union. A 7-day schedule
// collapses to dayField "*", so the vzorec survives a later "every day"
// lineup change without the line going stale. Returns
// [{ hour, minute, dayField, startTimes: ["HH:MM", ...] }] sorted for stable
// output (byte-identical vzorec on every run -- same contract as every other
// deterministic tool in this repo).
export function cronSlotsForSchedule(schedule, { minutesBefore = 15 } = {}) {
  const merged = new Map();
  for (const { startTime, dows } of distinctScheduleStarts(schedule)) {
    const { hour, minute, dayShift } = shiftedCronTime(startTime, minutesBefore);
    const shiftedDows = dows.map((d) => (d + 7 + dayShift) % 7);
    const slotKey = `${hour}:${minute}`;
    if (!merged.has(slotKey)) {
      merged.set(slotKey, { hour, minute, dows: new Set(), startTimes: [] });
    }
    const slot = merged.get(slotKey);
    for (const d of shiftedDows) slot.dows.add(d);
    slot.startTimes.push(startTime);
  }
  return [...merged.values()]
    .map(({ hour, minute, dows, startTimes }) => ({
      hour,
      minute,
      dayField: dows.size === 7 ? '*' : [...dows].sort((a, b) => a - b).join(','),
      startTimes,
    }))
    .sort((a, b) => a.hour - b.hour || a.minute - b.minute || a.dayField.localeCompare(b.dayField));
}

// Ready-to-paste crontab lines with a Slovenian comment header per slot.
// repoRoot/logFile are interpolated verbatim -- the CLI passes absolute
// paths, the tests pass short fakes. Sorted, so repeated runs produce
// byte-identical output (diff-friendly).
export function cronVzorecText(schedule, { minutesBefore = 15, repoRoot = '.', logFile = 'doctor.log' } = {}) {
  const slots = cronSlotsForSchedule(schedule, { minutesBefore });
  const lines = [
    `# Doctor pred vsako terminirano uro (izvlečeno iz station.json, ${minutesBefore} min pred začetkom)`,
  ];
  for (const slot of slots) {
    const before = slot.startTimes.join(', ');
    lines.push(`# termin: ${before}`);
    lines.push(
      `${slot.minute} ${slot.hour} * * ${slot.dayField} /bin/bash -lc 'cd ${repoRoot} && node src/cli/doctorCli.js >> ${logFile} 2>&1'`
    );
  }
  if (slots.length === 0) lines.push('# urnik je prazen -- ni česa razporediti');
  return lines.join('\n') + '\n';
}

