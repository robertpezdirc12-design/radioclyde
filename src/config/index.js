import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const configPath = path.join(__dirname, '..', '..', 'config.json');

if (!fs.existsSync(configPath)) {
  throw new Error(
    `config.json not found at ${configPath}. Copy config.example.json to config.json and fill in real values.`
  );
}

export const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));

// Every generated/operational path is derived from this one root rather than
// each being its own separately-configured absolute path -- moving to
// production means changing `dataDir` once, not hunting down individual
// path settings scattered across config.json.
config.paths = {
  stationFile: path.join(config.dataDir, 'station.json'),
  stationHashPath: path.join(config.dataDir, '.station_hash'),
  showDescriptionsDir: path.join(config.dataDir, 'show-descriptions'),
  // Optional per-show logo at <id>.png; falls back to public/logo.png when
  // a show doesn't have one yet (see server/showLogoProxy.js).
  showLogosDir: path.join(config.dataDir, 'show-logos'),
  // Every produced/directed show occurrence (weekday/showId/date/...) lives
  // under this one namespace, so config.dataDir's top level stays limited to
  // the small set of station-wide files instead of one directory per weekday.
  runningDir: path.join(config.dataDir, 'running'),
  historyFile: path.join(config.dataDir, 'history', 'played.jsonl'),
  logsDir: path.join(config.dataDir, 'logs'),
  nowPlayingPath: path.join(config.dataDir, 'now_playing.m3u'),
  nowPlayingStatePath: path.join(config.dataDir, 'now_playing_state.json'),
  fillerPath: path.join(config.dataDir, 'filler.m3u'),
  wikipediaCacheDir: path.join(config.dataDir, 'cache', 'wikipedia'),
  trackRatingKeysPath: path.join(config.dataDir, 'track_ratingkeys.json'),
  trackRatingKeysLockPath: path.join(config.dataDir, '.track_ratingkeys.lock'),
  nowPlayingTrackPath: path.join(config.dataDir, 'now_playing_track.json'),
  airedHistoryFile: path.join(config.dataDir, 'history', 'aired.jsonl'),
  // Listener-audience samples (analytics/listenerSamples.js): one JSON object
  // per line, appended by the scheduler's listener_sample job, pruned to
  // config.analytics.maxEntries. Read by the studio Analytics endpoint.
  listenerSamplesFile: path.join(config.dataDir, 'history', 'listener-samples.jsonl'),
  // Dead-air guard events (deadair/recordEvent.js, appended by radio.liq's
  // blank.detect callbacks): one JSON object per line, raw guard events,
  // paired into episodes by deadair/ledger.js for studio Diagnostics.
  deadAirEventsFile: path.join(config.dataDir, 'history', 'deadair.jsonl'),
  // Listener song requests / dedications (server/requestsStore.js): one JSON
  // object per line, appended by POST /api/requests, rewritten atomically on
  // moderation (studioRequestsApi.js).
  requestsFile: path.join(config.dataDir, 'requests.jsonl'),
  pollsFile: path.join(config.dataDir, 'polls.json'),
  // Web Push (push/vapid.js + push/subscriptions.js + push/dispatch.js):
  // everything the opt-in "show is starting" notifications need, under one
  // dataDir namespace. vapid.json holds the locally generated P-256 pair
  // (losing it invalidates existing browser subscriptions); subscriptions
  // are the minimal opt-in records (endpoint + encryption keys, no
  // accounts); sent.jsonl is the idempotence ledger (one line per
  // date@time@show already notified).
  pushDir: path.join(config.dataDir, 'push'),
  pushVapidFile: path.join(config.dataDir, 'push', 'vapid.json'),
  pushSubscriptionsFile: path.join(config.dataDir, 'push', 'subscriptions.json'),
  pushSentLedgerFile: path.join(config.dataDir, 'push', 'sent.jsonl'),
  artCacheDir: path.join(config.dataDir, 'cache', 'art'),
  // Persona system prompts + the script-review system prompt, split out of
  // this boot-time-loaded config.json into their own file so studio admin
  // edits take effect without a process restart -- see promptsUtil.js,
  // which re-reads this fresh on every call, the same no-caching pattern
  // scheduleUtil.js already uses for station.json.
  promptsFile: path.join(config.dataDir, 'prompts.json'),
  promptsLockPath: path.join(config.dataDir, '.prompts.lock'),
  stationLockPath: path.join(config.dataDir, '.station.lock'),
  // Imaging layer (scheduler/imagingPlaylists.js + liquidsoap/radio.liq):
  // short produced clips layered over the program. Node scans the clip
  // directories and writes the four .m3u files radio.liq watches; the clip
  // audio itself is produced out-of-band (TTS / ffmpeg), see
  // docs/imaging-layer.md -- the one exception is the promos layer, whose
  // schedule-driven clips are AUTO-produced by scheduler/promoProducer.js
  // when imaging.promos.enabled is true (operator-placed clips are equally
  // at home there; the rescan treats generated and operator clips
  // identically). A missing clip directory yields an empty .m3u,
  // which makes that Liquidsoap source fallible-empty -- the layer simply
  // drops off air instead of breaking anything.
  imagingIdDir: path.join(config.dataDir, 'imaging', 'id'),
  imagingStingerDir: path.join(config.dataDir, 'imaging', 'stingers'),
  imagingEmergencyDir: path.join(config.dataDir, 'imaging', 'emergency'),
  imagingIdPath: path.join(config.dataDir, 'imaging', 'id.m3u'),
  imagingStingerPath: path.join(config.dataDir, 'imaging', 'stingers.m3u'),
  imagingEmergencyPath: path.join(config.dataDir, 'imaging', 'emergency.m3u'),
  // Promos (Paket B2): the fourth imaging layer. Clips land in imaging/promos/
  // either from scheduler/promoProducer.js (schedule-driven, Edge TTS) or
  // from the operator's hand -- same pool either way, same .m3u contract as
  // the three siblings above.
  imagingPromosDir: path.join(config.dataDir, 'imaging', 'promos'),
  imagingPromosPath: path.join(config.dataDir, 'imaging', 'promos.m3u'),
  // Format clock (Paket D1, scheduler/formatClock.js): auto-produced BED
  // clips live in dataDir/beds/ -- deliberately NOT under imaging/ (that
  // tree's subdirectories are the four m3u LAYERS imagingPlaylists.js
  // scans; beds are not a layer, they ride the telnet queue, so a file here
  // never airs by merely existing). The flat name sits next to the
  // beds-leadin.wav bedQueue.js already generates at the dataDir root.
  // Deterministic weather_<date>_<HH-MM>.mp3 / nextshow_<id>_<date>_<HH-MM>.mp3
  // names are both the re-work guard and the stale-sweep key; the
  // beds-fired.jsonl ledger is the push/dispatch.js sent.jsonl pattern
  // (one line per fired slot key, count-pruned) and is covered by the daily
  // backup like every other idempotence ledger.
  bedsDir: path.join(config.dataDir, 'beds'),
  bedsFiredLedgerFile: path.join(config.dataDir, 'history', 'beds-fired.jsonl'),
  // R128 loudness alignment (lib/autocue.js + scheduler/autocueScan.js +
  // radio.liq's amplify(override="liq_amplify")): measured per-track LUFS
  // side index. Path-keyed, mtimeMs+size-checked, rewritten atomically by
  // the scan job; tracks without an entry annotate no liq_amplify and play
  // unaligned, exactly as before the feature existed.
  autocueIndexPath: path.join(config.dataDir, 'autocue_index.json'),
};
