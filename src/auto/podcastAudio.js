// P5 #2: MARKEC PODKAST -- audio sinteza skripte. Vzame načrt epizode
// (src/auto/podcast.js buildPodcastEpisode) in jo izriše v ZVOČNO datoteko:
// vsako [pogovor] vrstico izgovori Piper (isti piperVoice.js kot živa oddaja
// -- en glas, ena resnica), glasbene vrstice pa premakne iz REALNIH
// knjižnih datotek. Rezultat je podcast-MP3 (44.1 kHz stereo, 128 kbps) z
// VGRAJENIMI poglavji (ffmetadata -> ID3 CHAP) + ločena .txt z istimi
// poglavji za operaterja.
//
// Determinizem: skripta je bajtno deterministična, Piper sinteza pa je za
// isti model + isti tekst praktično stabilna, a je NI razglašena za
// bajtno-sestavljen del drevesa -- testi zato sintezo vedno INJEKTIRAJO
// (voiceRunner), živi potek pa je operatersko orodje.
//
// Skip-not-fail (ista pogodba kot oddaja): vrstica, ki ne pride do zvoka
// (piper padel, skladba nima datoteke), se POŠTENO preskoči in belei v
// načrtu; epizoda se sestavi iz tistega, kar je. Samo KO NI NIČesar,
// orodje pošteno pade (prazen MP3 je laž).
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createLogger } from '../lib/logger.js';
import { synthesizePiper } from './piperVoice.js';

const execFileAsync = promisify(execFile);
const log = createLogger('station');

const CHAPTER_LABELS = {
  podcastOpen: 'Otvoritev',
  intro: 'Naznanilo skladbe',
  podcastChat: 'Pogovor: zanimivost',
  podcastLaugh: 'Pogovor: smeh',
  podcastOutro: 'Zaključek',
};

// track -> real audio file, or null when there is none. Local library
// tracks carry localPath; Plex-only tracks don't -- those skip HONESTLY
// (talk-only episode) instead of inventing audio.
function defaultMusicResolver(track) {
  const file = track?.localPath;
  if (!file) return null;
  try {
    return fs.statSync(file).isFile() ? file : null;
  } catch {
    return null;
  }
}

// Real duration of one assembled piece, in seconds (float). ffprobe prints
// "duration=N.NNN" with -show_entries format=duration.
export async function probeDurationSeconds(file, runner = execFileAsync) {
  const { stdout } = await runner('ffprobe', [
    '-v', 'error', '-show_entries', 'format=duration', '-of', 'default=noprint_wrappers=1:nokey=1', file,
  ]);
  const seconds = Number.parseFloat(String(stdout).trim());
  if (!Number.isFinite(seconds) || seconds <= 0) {
    throw new Error(`ffprobe ni vrnil veljavnega trajanja za "${file}" (${String(stdout).trim() || 'prazno'})`);
  }
  return seconds;
}

// One chapter block in ffmetadata format (milliseconds timebase).
function chapterBlock({ title, startMs, endMs }) {
  return ['[CHAPTER]', 'TIMEBASE=1/1000', `START=${startMs}`, `END=${endMs}`, `title=${title}`].join('\n');
}

// Builds the ffmetadata text (global tags + one chapter per assembled piece).
export function buildChaptersMetadata({ station, date, pieces }) {
  const head = [';FFMETADATA1', `title=Markec Podkast -- ${date}`, `artist=${station}`, `date=${date}`].join('\n');
  const blocks = pieces.map((p, i) =>
    chapterBlock({ title: `${i + 1}. ${p.title}`, startMs: p.startMs, endMs: p.endMs })
  );
  return [head, ...blocks].join('\n') + '\n';
}

// The one ffmpeg invocation that stitches everything: every piece is its
// own -i (chapters file included, all inputs BEFORE output options), the
// concat FILTER normalizes mixed formats/rates on the way in, and the
// ffmetadata input carries the chapters. chaptersFile may be null (plain
// fallback) -- then no metadata input and no -map_metadata.
// Returned argv is also what tests pin.
export function buildFfmpegArgs({ inputs, chaptersFile, outPath }) {
  const args = ['-y'];
  // ALL inputs (chapters file included) come BEFORE any output options --
  // an -i placed after -map is parsed as a malformed input and the encode
  // dies with "Error parsing options for input file".
  for (const input of inputs) args.push('-i', input);
  if (chaptersFile) args.push('-i', chaptersFile);
  const labels = inputs.map((_, i) => `[${i}:a]`).join('');
  args.push('-filter_complex', `${labels}concat=n=${inputs.length}:v=0:a=1[out]`, '-map', '[out]');
  if (chaptersFile) {
    args.push('-map_metadata', String(inputs.length));
  }
  args.push('-codec:a', 'libmp3lame', '-b:a', '128k', '-ar', '44100', '-ac', '2', outPath);
  return args;
}

// Synthesizes one [pogovor] line with the podcast persona's piper voice.
// Kept as its own tiny function so tests can stub the module-level seams
// cleanly and the CLI stays declarative.
async function synthesizeTalkLine(line, outPath, persona, { voiceRunner } = {}) {
  await synthesizePiper(line.text, outPath, persona, voiceRunner ? { runner: voiceRunner } : {});
  return outPath;
}

// Main entry: episode plan -> assembled podcast MP3 (+ chapters sidecar).
// Never throws for a SKIPPED piece (they are reported); throws only when
// NOTHING assembled or when the final ffmpeg encode itself fails.
export async function synthesizePodcastEpisodeAudio(episode, {
  outDir,
  persona = 'markec',
  voiceRunner,
  processRunner = execFileAsync,
  probeDuration = probeDurationSeconds,
  musicResolver = defaultMusicResolver,
} = {}) {
  if (!episode?.lines?.length) throw new Error('Epizoda brez vrstic -- ničesar za sintezo.');
  const segDir = path.join(outDir, 'segi');
  fs.mkdirSync(segDir, { recursive: true });

  // 1) Render every line that CAN render; skips are honest and listed.
  // A [glasba] line is the ANNOUNCEMENT (spoken text) followed by the real
  // music file -- exactly the on-air shape "Zdaj sledi X" -> track. The two
  // pieces degrade independently: announcement without music still speaks,
  // music without announcement still plays.
  const inputs = [];
  const skipped = [];
  for (const [index, line] of episode.lines.entries()) {
    if (line.kind === 'pogovor' || line.kind === 'glasba') {
      const spokenTitle = line.kind === 'glasba' ? CHAPTER_LABELS.intro : (CHAPTER_LABELS[line.slot] ?? line.slot);
      if (line.text) {
        const segPath = path.join(segDir, String(index).padStart(2, '0') + '-' + line.slot + '.wav');
        try {
          await synthesizeTalkLine(line, segPath, persona, { voiceRunner });
          inputs.push({ kind: 'pogovor', slot: line.slot, title: spokenTitle, file: segPath });
        } catch (err) {
          log(`podcast-audio: govor "${line.slot}" preskočen (${err.message.split('\n')[0]})`);
          skipped.push({ kind: 'pogovor', slot: line.slot, title: spokenTitle, reason: err.message.split('\n')[0] });
        }
      }
      if (line.kind === 'glasba') {
        const track = episode.tracks[line.trackIndex];
        const file = musicResolver(track);
        if (file) {
          inputs.push({ kind: 'glasba', slot: line.slot, title: `${track.artist} -- ${track.title}`, file });
        } else {
          log(`podcast-audio: skladba "${track?.artist} -- ${track?.title}" brez datoteke -- preskočena (govor-ena epizoda)`);
          skipped.push({ kind: 'glasba', slot: line.slot, title: `${track?.artist} -- ${track?.title}`, reason: 'brez dostopne datoteke (Plex ali manjkajoča)' });
        }
      }
    }
  }

  if (inputs.length === 0) {
    throw new Error('Noben segment ni bil sintetiziran -- podkast ne more biti prazen MP3. Preveri voice mode / knjižnico.');
  }

  // 2) Real durations -> real chapter offsets (never invented).
  const pieces = [];
  let cursorMs = 0;
  for (const piece of inputs) {
    const seconds = await probeDuration(piece.file, processRunner);
    const startMs = Math.round(cursorMs);
    const endMs = startMs + Math.round(seconds * 1000);
    pieces.push({ ...piece, seconds: Math.round(seconds * 1000) / 1000, startMs, endMs });
    cursorMs = endMs;
  }

  // 3) Chapters sidecar + the stitch. Chapters are best-effort: if the
  // metadata input ever breaks an exotic ffmpeg build, the episode still
  // assembles without them (retry plain, log the fallback).
  const mp3Path = path.join(outDir, `${episode.date}-${episode.id}.mp3`);
  const chaptersPath = path.join(outDir, `${episode.date}-${episode.id}-poglavja.txt`);
  fs.writeFileSync(chaptersPath, buildChaptersMetadata({ station: episode.station, date: episode.date, pieces }));

  let argv = buildFfmpegArgs({ inputs: pieces.map((p) => p.file), chaptersFile: chaptersPath, outPath: mp3Path });
  try {
    await processRunner('ffmpeg', argv);
  } catch (err) {
    log(`podcast-audio: sestava s poglavji ni uspela (${err.message.split('\n')[0]}) -- poskušam brez njih`);
    argv = buildFfmpegArgs({ inputs: pieces.map((p) => p.file), chaptersFile: null, outPath: mp3Path });
    await processRunner('ffmpeg', argv);
  }
  const bytes = fs.existsSync(mp3Path) ? fs.statSync(mp3Path).size : 0;
  if (bytes === 0) throw new Error(`ffmpeg ni zapisal zvoka v "${mp3Path}" -- preveri ffmpeg/libmp3lame.`);

  return {
    mp3Path,
    chaptersPath,
    pieces,
    skipped,
    seconds: Math.round(cursorMs / 100) / 10,
    ffmpegArgs: argv,
  };
}
