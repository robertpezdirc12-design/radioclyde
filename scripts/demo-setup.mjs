// Demo instance for issue #2 verification: writes a self-contained
// config.json + dataDir with REAL-shaped sample data (schedule, aired
// history incl. one repeat, voice clips, pre-generated slots, music files),
// so the listener page, studio views, and every new API endpoint can be
// exercised end-to-end without Icecast/Plex/LM Studio. Backup/restore of a
// pre-existing config.json follows test/fixtures.mjs's pattern.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CONFIG_PATH = path.join(REPO, 'config.json');
const BACKUP_PATH = `${CONFIG_PATH}.demo-backup`;

// --restore: undo the demo takeover below -- put the backed-up config.json
// back and exit before anything else is touched (the demo dataDir stays on
// disk; delete it yourself when you are done looking at the demo).
if (process.argv.includes('--restore')) {
  if (fs.existsSync(BACKUP_PATH)) {
    fs.writeFileSync(CONFIG_PATH, fs.readFileSync(BACKUP_PATH, 'utf8'));
    fs.rmSync(BACKUP_PATH);
    console.log(`RESTORED: ${CONFIG_PATH} <- ${BACKUP_PATH}`);
    console.log(`  demo dataDir left on disk: ${path.join(REPO, 'data', 'demo')}`);
  } else {
    console.error(`Nothing to restore: ${BACKUP_PATH} does not exist.`);
    process.exitCode = 1;
  }
  process.exit(process.exitCode || 0);
}

const backup = fs.existsSync(CONFIG_PATH) ? fs.readFileSync(CONFIG_PATH, 'utf8') : null;
if (backup) fs.writeFileSync(BACKUP_PATH, backup);

const dataDir = path.join(REPO, 'data', 'demo');
fs.rmSync(dataDir, { recursive: true, force: true });
fs.mkdirSync(dataDir, { recursive: true });

// --- music library (real WAVs, tags via filename) ---
const musicDir = path.join(dataDir, 'music');
fs.mkdirSync(musicDir, { recursive: true });
const SONGS = [
  ['Ansambel Roka Žlindere', 'Vetriči'],
  ['Parni Valjak', 'Prokleta je nedelja'],
  ['King Foo', 'Za očmi mi'],
  ['Mi2', 'Kaj je ljubezen'],
  ['NiČ In Nič', 'Samo tko'],
  ['Big Foot Mama', 'Tistega dne'],
];
const ratingKeys = {};
function writeWav(file, seconds = 3) {
  const rate = 8000;
  const samples = Math.floor(rate * seconds);
  const data = Buffer.alloc(samples * 2);
  for (let i = 0; i < samples; i++) data.writeInt16LE(Math.round(8000 * Math.sin((2 * Math.PI * 440 * i) / rate)), i * 2);
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
  fs.writeFileSync(file, Buffer.concat([header, data]));
}
for (const [i, [artist, title]] of SONGS.entries()) {
  const file = path.join(musicDir, `${artist} - ${title}.wav`);
  writeWav(file);
  ratingKeys[file] = crypto.createHash('sha1').update(file).digest('hex').slice(0, 12);
}

// --- schedule anchored to "now" so the grid has a live on-air mark ---
// Display names come from each show's markdown brief (H1 + **Personas:**),
// resolved by server/showName.js -- same architecture as a real station.
const now = new Date();
const pad = (n) => String(n).padStart(2, '0');
const hhmm = (d) => `${pad(d.getHours())}:${pad(d.getMinutes())}`;
const weekdayKeys = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
const today = weekdayKeys[now.getDay()];
const startAgo = new Date(now.getTime() - 20 * 60 * 1000); // started 20 min ago, 120 min slot -> on air now
const startNext = new Date(now.getTime() + 90 * 60 * 1000);
const SHOWS = [
  { id: 'dopoldanski-miks', name: 'Dopoldanski miks', persona: 'elena', duration: 180 },
  { id: 'popoldanski-ritmi', name: 'Popoldanski ritmi', persona: 'matija', duration: 120 },
  { id: 'veerni-anton', name: 'Večerni Antonio', persona: 'anton', duration: 90 },
  { id: 'jutranji-budilnik', name: 'Jutranji budilnik', persona: 'elena', duration: 120 },
];
const descriptionsDir = path.join(dataDir, 'show-descriptions');
fs.mkdirSync(descriptionsDir, { recursive: true });
for (const s of SHOWS) {
  fs.writeFileSync(
    path.join(descriptionsDir, `${s.id}.md`),
    `# 📻 ${s.name}\n\n**Duration:** ${s.duration} min\n**Personas:** ${s.persona}\n**Segments:** weather\n\n---\n\n## Description\n\nDemo show brief for the issue #2 verification instance.\n`
  );
}
const brief = (s) => path.join('show-descriptions', `${s.id}.md`);
const byId = Object.fromEntries(SHOWS.map((s) => [s.id, s]));
const schedule = {
  [today]: [
    { id: 'dopoldanski-miks', startTime: '07:00', durationMinutes: 180, description: brief(byId['dopoldanski-miks']) },
    { id: 'popoldanski-ritmi', startTime: hhmm(startAgo), durationMinutes: 120, description: brief(byId['popoldanski-ritmi']) },
    { id: 'veerni-anton', startTime: hhmm(startNext), durationMinutes: 90, description: brief(byId['veerni-anton']) },
  ],
  [weekdayKeys[(now.getDay() + 1) % 7]]: [
    { id: 'jutranji-budilnik', startTime: '06:30', durationMinutes: 120, description: brief(byId['jutranji-budilnik']) },
  ],
};

fs.writeFileSync(
  path.join(dataDir, 'station.json'),
  JSON.stringify({ station: { name: 'Radio Markec Demo', filler: { excludeKeywords: [] } }, schedule }, null, 2)
);

// --- now playing track (aired "just now") ---
const entry = {
  ratingKey: ratingKeys[path.join(musicDir, 'Big Foot Mama - Tistega dne.wav')],
  artist: 'Big Foot Mama',
  title: 'Tistega dne',
  album: 'Doba za malo',
  durationMs: 214000,
  playedAt: new Date(now.getTime() - 45 * 1000).toISOString(),
};
fs.writeFileSync(path.join(dataDir, 'now_playing_track.json'), JSON.stringify(entry));

// --- aired history: 8 entries, one repeat inside the 24h window ---
const aired = [
  ['Parni Valjak', 'Prokleta je nedelja', 8.2],
  ['King Foo', 'Za očmi mi', 7.4],
  ['Ansambel Roka Žlindere', 'Vetriči', 6.6],
  ['Mi2', 'Kaj je ljubezen', 5.1],
  ['Big Foot Mama', 'Tistega dne', 3.9],
  ['NiČ In Nič', 'Samo tko', 2.7],
  ['Big Foot Mama', 'Tistega dne', 1.4], // repeat inside window -> diagnostics offender
  ['Parni Valjak', 'Prokleta je nedelja', 0.6],
];
fs.mkdirSync(path.join(dataDir, 'history'), { recursive: true });
const airedLines = aired.map(([artist, title, hoursAgo]) => {
  const file = path.join(musicDir, `${artist} - ${title}.wav`);
  return JSON.stringify({
    ratingKey: ratingKeys[file],
    artist,
    title,
    album: '',
    showId: 'popoldanski-ritmi',
    playedAt: new Date(now.getTime() - hoursAgo * 3600 * 1000).toISOString(),
  });
});
fs.writeFileSync(path.join(dataDir, 'history', 'aired.jsonl'), airedLines.join('\n') + '\n');

// --- filler rotation ledger ---
fs.writeFileSync(
  path.join(dataDir, 'history', 'filler-rotation.jsonl'),
  airedLines.slice(0, 4).join('\n') + '\n'
);

// --- playlists (real m3u shapes) ---
const annotate = (file) => `annotate:title="${path.basename(file, '.wav')}":${file}`;
fs.writeFileSync(
  path.join(dataDir, 'now_playing.m3u'),
  [SONGS.map(([a, t]) => path.join(musicDir, `${a} - ${t}.wav`)).map(annotate).join('\n'), ''].join('\n')
);
fs.writeFileSync(
  path.join(dataDir, 'filler.m3u'),
  [SONGS.slice(0, 3).map(([a, t]) => path.join(musicDir, `${a} - ${t}.wav`)).map(annotate).join('\n'), ''].join('\n')
);

// --- voice clips (persona dirs with slot wavs) + pre-generated slots ---
for (const persona of ['elena', 'matija', 'anton']) {
  const dir = path.join(dataDir, 'voice-clips', persona);
  fs.mkdirSync(dir, { recursive: true });
  for (const slot of ['open.wav', 'close.wav', 'handoff.wav', 'weather.wav']) writeWav(path.join(dir, slot), 1);
}
const pregenDir = path.join(dataDir, 'pre-generated');
fs.mkdirSync(pregenDir, { recursive: true });
for (const f of ['general_open.wav', 'general_close.wav', 'general_handoff_weather.wav']) writeWav(path.join(pregenDir, f), 1);

// --- logs ---
fs.mkdirSync(path.join(dataDir, 'logs'), { recursive: true });
fs.writeFileSync(
  path.join(dataDir, 'logs', 'web.log'),
  [
    `[${new Date().toISOString()}] Listening on 0.0.0.0:8123`,
    `[${new Date().toISOString()}] scheduler: tick -- 0 occurrences due`,
  ].join('\n') + '\n'
);
fs.writeFileSync(
  path.join(dataDir, 'logs', 'station.log'),
  [`[${new Date().toISOString()}] scrobble: ratingKey ${entry.ratingKey} ("Tistega dne")`].join('\n') + '\n'
);

// --- config.json (demo) ---
const config = {
  dataDir,
  autoRadio: {
    enabled: false, // scheduler ticks but produces nothing in the demo
    stationName: 'Radio Markec Demo',
    music: { source: 'local', localDirs: [musicDir] },
    voice: {
      mode: 'clips',
      clipsDir: 'voice-clips',
      defaultEspeakVoice: 'sl',
      defaultPiperVoice: 'voices/sl_SI-artur-medium.onnx', // intentionally missing -> honest "model file missing"
      personas: { elena: { edgeVoice: 'sl-SI-PetraNeural' }, matija: { edgeVoice: 'sl-SI-RokNeural' } },
    },
  },
  weather: { timezone: 'Europe/Ljubljana', latitude: 46.05, longitude: 14.5, url: 'https://api.open-meteo.com/v1/forecast' },
  schedule: { minLeadTimeMinutes: 9999 }, // demo: scheduler must never try to produce a script (no LM Studio here)
  filler: { poolSize: 6, regenerateIntervalMinutes: 360, maxTrackDurationSeconds: 600, rotationWindowHours: 24 },
  icecast: { sourceHost: '127.0.0.1', publicHost: 'localhost', port: 8801, mount: '/stream', bitrate: 192 },
  web: { port: 8123, trustedNetworks: [], listeners: [] },
  studio: { users: [{ username: 'demo', password: 'demo123' }] },
  liquidsoap: { telnetHost: '127.0.0.1', telnetPort: 1234 },
};
fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));

console.log('DEMO READY');
console.log(`  config: ${CONFIG_PATH}${backup ? ` (original backed up to ${BACKUP_PATH})` : ' (new)'}`);
if (backup) console.log(`  restore: node scripts/demo-setup.mjs --restore`);
console.log(`  dataDir: ${dataDir}`);
console.log(`  URL: http://127.0.0.1:8123/  studio: demo / demo123`);
