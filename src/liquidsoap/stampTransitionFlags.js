// Transition flag stamping (P3 #11, roadmap row 11): edits imaging-free
// music playlists (filler.m3u, now_playing.m3u) in place, adding or removing
// the annotate: metadata flags radio.liq's dj_transition reads once the box
// runs Liquidsoap >= 2.4.6 (liquidsoap/dj_transitions.liq):
//
//   liq_sweep="1"    on the INCOMING track -- filter choke out of the old
//                    track, surfacing + bass-swap into the new one,
//   liq_washout="1"  on the ENDING track -- exp fade + one-shot slapback
//                    echo (optional liq_washout_delay, seconds, default 0.30
//                    in dj_transitions.liq),
//   liq_dissolve="1" on the INCOMING track -- four-comb early-reflection
//                    smear under the new pick.
//
// The tool is deliberately dumb and deterministic: it rewrites annotate
// groups only, never reorders entries, never touches bare paths' URIs, and
// it does NOT enforce the washout > dissolve > sweep precedence -- that is
// dj_transition's job at seam time (a track can legitimately carry
// liq_washout for the seam it ENDS on and liq_dissolve for the seam it
// STARTS on; the mixer arbitrates per seam). What the tool guarantees is
// idempotence: stamping the same flag twice produces the same file, and
// --clear removes exactly what --set added.
//
// Line contract (same as every writer in this repo, director/playlist.js
// included): an entry is either `annotate:key="v",...:/path` or a bare
// `/path`. The annotate group is everything before the FIRST ':'; the URI
// is the rest, passed through untouched (paths with ':' would break LS's
// annotate protocol itself, so no writer produces them). Comment (#) and
// empty lines pass through unchanged. Bare paths GET wrapped when a flag is
// set -- annotate wrapping is the standard request protocol and the
// scrobble handler reads "filename" (never "initial_uri"), so wrapping is
// invisible to scrobbling, aired history and now-playing (confirmed live
// 2026-07-29, see radio.liq's scrobble block).
import fs from 'node:fs';
import path from 'node:path';
import { createLogger } from '../lib/logger.js';

const log = createLogger('station');

export const TRANSITION_FLAGS = {
  sweep: 'liq_sweep',
  washout: 'liq_washout',
  dissolve: 'liq_dissolve',
};
export const WASHOUT_DELAY_KEY = 'liq_washout_delay';

function parseAnnotateLine(line) {
  const match = /^annotate:([^:]*):(.*)$/.exec(line);
  if (!match) return null;
  const keys = [];
  for (const group of match[1].split(',')) {
    const kv = /^([^=]+)=(.*)$/.exec(group.trim());
    if (kv) keys.push([kv[1].trim(), kv[2].trim()]);
  }
  return { keys, uri: match[2] };
}

function serializeAnnotateLine(keys, uri) {
  if (keys.length === 0) return uri;
  return `annotate:${keys.map(([k, v]) => `${k}=${v}`).join(',')}:${uri}`;
}

// Rewrites ONE playlist line per { set: [...names], clear: [...names],
// delay: string|undefined, only: string|undefined }. Returns the new line
// and whether anything changed. Unknown effect names throw -- a typo must
// be a loud error, not a silently inert stamp.
export function stampFlagsOnLine(line, { set = [], clear = [], delay, only } = {}) {
  for (const name of [...set, ...clear]) {
    if (!(name in TRANSITION_FLAGS)) {
      throw new Error(`Neznan učinek prehoda: "${name}" (dovoljeno: ${Object.keys(TRANSITION_FLAGS).join(', ')})`);
    }
  }
  if (only !== undefined && !line.includes(only)) return { line, changed: false };
  const trimmed = line.trim();
  if (trimmed === '' || trimmed.startsWith('#')) return { line, changed: false };
  const parsed = parseAnnotateLine(line);
  const keys = parsed ? [...parsed.keys] : [];
  const uri = parsed ? parsed.uri : line;
  let changed = false;
  for (const name of clear) {
    const key = TRANSITION_FLAGS[name];
    const idx = keys.findIndex(([k]) => k === key);
    if (idx >= 0) { keys.splice(idx, 1); changed = true; }
    if (name === 'washout') {
      const dIdx = keys.findIndex(([k]) => k === WASHOUT_DELAY_KEY);
      if (dIdx >= 0) { keys.splice(dIdx, 1); changed = true; }
    }
  }
  for (const name of set) {
    const key = TRANSITION_FLAGS[name];
    const entry = [key, '"1"'];
    const idx = keys.findIndex(([k]) => k === key);
    if (idx >= 0) {
      if (keys[idx][1] !== '"1"') { keys[idx] = entry; changed = true; }
    } else {
      keys.push(entry);
      changed = true;
    }
    if (name === 'washout' && delay !== undefined) {
      const dEntry = [WASHOUT_DELAY_KEY, `"${String(delay)}"`];
      const dIdx = keys.findIndex(([k]) => k === WASHOUT_DELAY_KEY);
      if (dIdx >= 0) {
        if (keys[dIdx][1] !== dEntry[1]) { keys[dIdx] = dEntry; changed = true; }
      } else {
        keys.push(dEntry);
        changed = true;
      }
    }
  }
  const next = serializeAnnotateLine(keys, uri);
  return { line: next, changed: changed || next !== line };
}

// Stamps a whole m3u file in place. Returns an honest summary; the file is
// written only when at least one line changed (a no-op run leaves mtime -- and
// therefore playlist reload churn -- alone).
export function stampTransitionFlags(m3uPath, options = {}) {
  const file = path.resolve(String(m3uPath));
  if (!fs.existsSync(file)) {
    return { ok: false, error: `Playlist ne obstaja: ${file}` };
  }
  const lines = fs.readFileSync(file, 'utf8').split('\n');
  // "all" is a CLI convenience expanded here, at the only layer that knows
  // the whole vocabulary; the line-level API stays strict about names.
  const clear = (options.clear ?? []).includes('all') ? Object.keys(TRANSITION_FLAGS) : options.clear;
  const lineOptions = { ...options, clear };
  let changed = 0;
  let entries = 0;
  const out = lines.map((line) => {
    const trimmed = line.trim();
    const isEntry = trimmed !== '' && !trimmed.startsWith('#');
    if (isEntry) entries += 1;
    const { line: next, changed: lineChanged } = stampFlagsOnLine(line, lineOptions);
    if (lineChanged) changed += 1;
    return next;
  });
  if (changed > 0) fs.writeFileSync(file, out.join('\n'));
  log(`stampTransitionFlags: ${file} -- ${changed}/${entries} vnosov prepisanih`);
  return { ok: true, file, entries, changed };
}

function printUsage() {
  console.log(`Uporaba:
  node src/liquidsoap/stampTransitionFlags.js <playlist.m3u> --set sweep|washout|dissolve [--delay <sekunde>] [--only <podniz-poti>]
  node src/liquidsoap/stampTransitionFlags.js <playlist.m3u> --clear sweep|washout|dissolve|all [--only <podniz-poti>]
  node src/liquidsoap/stampTransitionFlags.js <playlist.m3u> --list

Primeri:
  node src/liquidsoap/stampTransitionFlags.js data/filler.m3u --set sweep --only "Nightcall"
  node src/liquidsoap/stampTransitionFlags.js data/filler.m3u --set washout --delay 0.45
  node src/liquidsoap/stampTransitionFlags.js data/filler.m3u --clear all`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2);
  const file = args[0];
  const has = (name) => args.includes(name);
  const value = (name) => {
    const idx = args.indexOf(name);
    return idx >= 0 ? args[idx + 1] : undefined;
  };
  if (!file || has('--help') || has('-h') || (!has('--set') && !has('--clear') && !has('--list'))) {
    printUsage();
    process.exit(file && (has('--set') || has('--clear') || has('--list')) ? 0 : 1);
  }
  const options = { only: value('--only') };
  // "--set"/"--clear" as the LAST argv token (no value after it) used to read
  // args[idx + 1] === undefined and die on .split(',') with a bare TypeError
  // -- fail with the usage text instead, like every other bad invocation.
  const listValue = (name) => {
    const v = value(name);
    if (v === undefined || v === '') {
      printUsage();
      process.exit(1);
    }
    return v.split(',');
  };
  if (has('--set')) {
    options.set = listValue('--set');
    if (value('--delay') !== undefined) options.delay = value('--delay');
  }
  if (has('--clear')) options.clear = listValue('--clear');
  if (has('--list')) {
    const lines = fs.readFileSync(path.resolve(file), 'utf8').split('\n');
    for (const [i, line] of lines.entries()) {
      const parsed = parseAnnotateLine(line.trim());
      if (!parsed) continue;
      const flags = Object.entries(TRANSITION_FLAGS)
        .filter(([, key]) => parsed.keys.some(([k]) => k === key))
        .map(([name]) => name);
      const delay = parsed.keys.find(([k]) => k === WASHOUT_DELAY_KEY);
      console.log(`${String(i + 1).padStart(4)}: ${flags.length ? flags.join(',') : '-'}${delay ? `(delay=${delay[1]})` : ''} ${parsed.uri}`);
    }
    process.exit(0);
  }
  const result = stampTransitionFlags(file, options);
  if (!result.ok) {
    console.error(result.error);
    process.exit(1);
  }
  console.log(`${result.file}: ${result.changed}/${result.entries} vnosov prepisanih`);
}
