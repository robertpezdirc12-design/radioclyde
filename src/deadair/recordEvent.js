#!/usr/bin/env node
// Invoked by radio.liq's dead-air guard (P2 #9): blank.detect's on_blank and
// on_noise callbacks fire this once per state transition, as a detached OS
// process (the callback runs in Liquidsoap's main streaming thread and must
// stay fast -- same pattern as plex/scrobbleTrack.js, process.run with a
// trailing "&"). Appends exactly one JSON line to
// config.paths.deadAirEventsFile; pairing raw events into human-meaningful
// episodes is deadair/ledger.js's job, so this file stays dumb by design.
//
// The event type comes from Liquidsoap, the timestamp from Node -- one clock
// (this box), no clock-skew question between the two halves.
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config/index.js';
import { createLogger } from '../lib/logger.js';
import { toLocalISOString } from '../lib/time.js';

const log = createLogger('station');

// The four transitions radio.liq wires, one per detector edge. Kept as a
// closed set so a typo'd or future event type can't silently pollute the
// ledger -- recordEvent refuses it loudly instead.
const EVENT_TYPES = new Set(['program_blank', 'program_sound', 'air_blank', 'air_sound']);

const type = process.argv[2];
if (!EVENT_TYPES.has(type)) {
  log(`ERROR: unknown dead-air event type "${type ?? '(none)'}" (expected one of: ${[...EVENT_TYPES].join(', ')})`);
  process.exitCode = 1;
} else {
  fs.mkdirSync(path.dirname(config.paths.deadAirEventsFile), { recursive: true });
  const entry = { type, at: toLocalISOString() };
  fs.appendFileSync(config.paths.deadAirEventsFile, JSON.stringify(entry) + '\n');
  log(`Dead-air event recorded: ${type} at ${entry.at}.`);
}
