// Dead-air ledger reader (P2 #9): pairs the raw blank.detect transitions that
// radio.liq's guard appends via deadair/recordEvent.js into human-meaningful
// episodes for studio Diagnostics. The writer is deliberately dumb (one JSON
// line per event); ALL interpretation lives here, under the project's
// honest-failure rules -- a missing file, malformed lines, or events that
// don't pair up are reported for what they are, never papered over.
//
// Event vocabulary (closed set, see recordEvent.js):
//   program_blank / program_sound -- the program chain (show+filler,
//     requests, stingers, ID) went silent / came back. A closed program
//     episode is "the guard worked": blank.strip made the silent program
//     unavailable and the emergency bed covered it.
//   air_blank / air_sound -- the FINAL air (post-mksafe, emergency bed
//     included) went silent / came back. These mean every layer of the
//     degradation ladder failed at once -- the operator must see them first.
//
// Pairing rule per layer: a *_blank opens an episode, the next *_sound of the
// same layer closes it. Detectors alternate blank/sound by construction (one
// state machine per layer), so in practice every episode pairs cleanly;
// anything else -- a sound with no open episode (LS restarted mid-blank or
// the ledger truncated) or a second blank while one is open -- is kept as a
// note-carrying episode instead of being silently dropped.
import fs from 'node:fs';
import { config } from '../config/index.js';

const LAYERS = [
  { prefix: 'program_', layer: 'program' },
  { prefix: 'air_', layer: 'air' },
];

function layerOf(type) {
  const hit = LAYERS.find((l) => type.startsWith(l.prefix));
  return hit ? hit.layer : null;
}

// Reads and parses the ledger. Returns raw chronological events plus a count
// of skipped lines -- malformed lines never abort the read (a torn append is
// exactly what appendFileSync + a crash can produce), they're just counted.
export function readDeadAirEvents() {
  let raw;
  try {
    raw = fs.readFileSync(config.paths.deadAirEventsFile, 'utf8');
  } catch {
    return { exists: false, events: [], skipped: 0 };
  }
  const events = [];
  let skipped = 0;
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try {
      const ev = JSON.parse(line);
      // A line must be a known event type with a parseable timestamp --
      // anything else can't be paired into an episode and would lie if kept.
      if (
        ev &&
        typeof ev.type === 'string' &&
        layerOf(ev.type) &&
        (ev.type.endsWith('_blank') || ev.type.endsWith('_sound')) &&
        typeof ev.at === 'string' &&
        !Number.isNaN(new Date(ev.at).getTime())
      ) {
        events.push({ type: ev.type, at: ev.at });
      } else {
        skipped += 1;
      }
    } catch {
      skipped += 1;
    }
  }
  return { exists: true, events, skipped };
}

// Pure pairing math (tests feed synthetic events here directly).
export function pairDeadAirEpisodes(events) {
  const episodes = [];
  const open = { program: null, air: null };
  for (const ev of events) {
    const layer = layerOf(ev.type);
    const kind = ev.type.endsWith('_blank') ? 'blank' : 'sound';
    if (kind === 'blank') {
      if (open[layer]) {
        // Cannot come from the detectors (blank alternates with sound);
        // keep the FIRST open -- it's the longest honest reading of the
        // silence -- and say why the extra blank was folded in.
        open[layer].note = 'second blank while already open (folded in)';
        continue;
      }
      open[layer] = { layer, openedAt: ev.at, closedAt: null, durationMs: null };
    } else if (open[layer]) {
      const ep = open[layer];
      ep.closedAt = ev.at;
      ep.durationMs = Math.max(0, new Date(ev.at).getTime() - new Date(ep.openedAt).getTime());
      episodes.push(ep);
      open[layer] = null;
    } else {
      episodes.push({
        layer,
        openedAt: null,
        closedAt: ev.at,
        durationMs: null,
        note: 'sound without a matching blank (restart or truncated ledger?)',
      });
    }
  }
  for (const ep of Object.values(open)) {
    if (ep) episodes.push(ep);
  }
  return episodes;
}

// Diagnostics view: the tail of the ledger plus whatever is still silent
// right now. ongoing is the most recent episode without a close -- "the
// program is silent as we speak" or, for layer air, "air is actually dead".
export function deadAirSummary() {
  const { exists, events, skipped } = readDeadAirEvents();
  if (!exists) {
    return {
      exists: false,
      totalEvents: 0,
      skipped: 0,
      // Empty and never-fired are the same honest answer: the guard has
      // never had anything to report since the ledger existed.
      episodes: [],
      ongoing: null,
    };
  }
  const episodes = pairDeadAirEpisodes(events);
  const ongoing =
    [...episodes]
      .reverse()
      .find((ep) => ep.closedAt === null) ?? null;
  return {
    exists: true,
    totalEvents: events.length,
    skipped,
    episodes: episodes.slice(-5),
    ongoing,
  };
}
