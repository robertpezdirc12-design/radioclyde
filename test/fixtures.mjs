// Self-contained test scaffolding. Audit 2026-10-24 finding: the PR's tests
// depended on a machine-specific 55-track library and on a hand-made
// config.json, so `node --test test/` failed on every clean checkout (no
// config.json -> importing src/config/index.js throws). Everything a test
// needs is generated here: a repo-root config.json written fresh (any
// pre-existing one is backed up and restored on exit -- node --test runs each
// file in its own process, so this is safe), a per-file dataDir under
// data/test-<name>/ (already gitignored via data/), and tiny valid WAV
// fixtures for library/playlist tests -- no ffmpeg, no network, no real music.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CONFIG_PATH = path.join(REPO, 'config.json');

let restored = false;

export function repoRoot() {
  return REPO;
}

// Must run BEFORE importing any src/ module (config.json is read once at
// module load). Returns the config object it wrote.
export function setupTestConfig(testName, overrides = {}) {
  const backupPath = `${CONFIG_PATH}.test-backup`;
  let hadExisting = false;
  let original = null;
  if (fs.existsSync(CONFIG_PATH)) {
    hadExisting = true;
    original = fs.readFileSync(CONFIG_PATH, 'utf8');
    // Persist the backup on disk too -- if the process is killed -9 before
    // the exit hook runs, the original is still recoverable.
    fs.writeFileSync(backupPath, original);
  }

  const dataDir = path.join(REPO, 'data', `test-${testName}`);
  fs.rmSync(dataDir, { recursive: true, force: true });
  fs.mkdirSync(dataDir, { recursive: true });

  const config = {
    dataDir,
    autoRadio: {
      enabled: true,
      stationName: 'Test Station',
      music: { source: 'local', localDirs: [] },
      rules: { artistCooldownHours: 3 },
      voice: { mode: 'none' },
    },
    shows: { repeatWindowDays: 30, maxTrackDurationSeconds: 300, minTrackDurationSeconds: 0 },
    weather: { url: 'https://api.open-meteo.com/v1/forecast', latitude: 46.05, longitude: 14.5, timezone: 'Europe/Ljubljana' },
    schedule: {
      scriptLeadTimeMinutes: 120,
      scriptCheckIntervalMinutes: 15,
      directLeadTimeMinutes: 15,
      directCheckIntervalMinutes: 2,
      prewarmCheckIntervalMinutes: 15,
      prewarmHorizonMinutes: 1440,
      nowPlayingCheckIntervalMinutes: 1,
      scheduleWatchIntervalMinutes: 1,
      maxCatchUpMinutes: 10,
      minLeadTimeMinutes: 30,
    },
    filler: { poolSize: 200, regenerateIntervalMinutes: 360, maxTrackDurationSeconds: 600, rotationWindowHours: 24 },
    cleanup: { retentionDays: 7, intervalMinutes: 360 },
    backup: { dir: path.join(dataDir, 'backups'), intervalMinutes: 1440 },
    liquidsoap: { telnetHost: '127.0.0.1', telnetPort: 1234 },
    icecast: { sourceHost: '127.0.0.1', publicHost: 'localhost', port: 8001, mount: '/stream', bitrate: 128 },
    web: { port: 3999 },
    ...overrides,
  };
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));

  // Minimal station.json -- the real station writes this via
  // stationWriter.js; scheduler jobs (loadNeverPlay/loadStation) read it on
  // every tick, so tests need it present too.
  if (!fs.existsSync(path.join(dataDir, 'station.json'))) {
    fs.writeFileSync(
      path.join(dataDir, 'station.json'),
      JSON.stringify({ station: { name: 'Test Station', neverPlay: { keywords: [], artists: [] } } })
    );
  }

  process.on('exit', () => {
    if (restored) return;
    restored = true;
    try {
      if (hadExisting) fs.writeFileSync(CONFIG_PATH, original);
      else fs.rmSync(CONFIG_PATH, { force: true });
      if (fs.existsSync(backupPath)) fs.rmSync(backupPath, { force: true });
    } catch {
      /* best-effort restore */
    }
  });

  return config;
}

// A real, valid 16-bit PCM mono 8kHz WAV of `seconds` seconds (soft 440Hz
// sine) -- music-metadata parses it (title/artist/duration), and any local
// audio player could too. Lets library/filler tests run without ffmpeg,
// fixture MP3s, or a real music collection.
export function writeWav(file, seconds = 2) {
  const rate = 8000;
  const samples = Math.floor(rate * seconds);
  const data = Buffer.alloc(samples * 2);
  for (let i = 0; i < samples; i++) {
    data.writeInt16LE(Math.round(8000 * Math.sin((2 * Math.PI * 440 * i) / rate)), i * 2);
  }
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + data.length, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(rate, 24);
  header.writeUInt32LE(rate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(data.length, 40);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, Buffer.concat([header, data]));
  return file;
}

// Same ratingKey derivation as localLibrary.js (sha1 of absolute path,
// 12 chars) so tests can predict a fixture track's identity without importing
// the module under test.
export function ratingKeyForFile(absolutePath) {
  return crypto.createHash('sha1').update(absolutePath).digest('hex').slice(0, 12);
}

// Parses an m3u (annotate:...:path lines or bare paths) into sorted bare paths.
export function m3uPaths(file) {
  return fs
    .readFileSync(file, 'utf8')
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => l.slice(l.lastIndexOf(':') + 1))
    .sort();
}
