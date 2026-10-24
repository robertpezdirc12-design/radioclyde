// The no-model voice layer. In autoRadio mode every `dj`/`live` segment's
// audio comes from one of five sources, chosen by
// config.autoRadio.voice.mode -- none of which is a self-hosted AI TTS model:
//
//   "clips"  -- pre-recorded clips, one file per speech slot, per persona:
//               <dataDir>/<clipsDir>/<persona>/<slot>.wav
//               (optionally numbered variants <slot>-1.wav ... chosen by the
//               same hash that picks the template variant, so text and clip
//               stay in sync). Falls back to <clipsDir>/default/ for personas
//               with no folder of their own. A missing clip SKIPS that
//               speech segment with a logged NOTE rather than failing the
//               show -- music keeps playing either way.
//   "edge"   -- Microsoft Edge neural TTS (auto/edgeTts.js): real neural
//               Slovenian voices (sl-SI-PetraNeural / sl-SI-RokNeural), no
//               API key, no local model. Unofficial service, so on any
//               failure the segment either falls back per
//               autoRadio.voice.edgeFallback (clips/sapi/espeak/none) or is
//               skipped, exactly like a missing clip.
//   "piper"  -- local Piper TTS via the piper1-gpl runtime (auto/
//               piperVoice.js, single source of truth shared with
//               pre-generate-clips.mjs and voiceStatus.js). piper-tts
//               1.8.0 on PyPI, the maintained successor of the archived
//               rhasspy/piper. Voice is either an .onnx path (old style,
//               still valid) or a piper1-gpl voice key like
//               "sl_SI-artur-medium" -- a missing key downloads ONCE from
//               HuggingFace (piper.download_voices) before synthesis;
//               no network is needed after that. Slovenian voice:
//               sl_SI-artur-medium.
//   "sapi"   -- Windows SAPI (System.Speech) speaks the rendered template
//               text. Zero downloads, zero models: the voices Windows ships
//               with. Voice name is per-persona config (e.g. "Microsoft
//               Matej"), falling back to the system default voice.
//   "espeak" -- espeak-ng (Linux/anywhere), classic formant synthesis, no
//               model. Per-persona espeak voice code (e.g. "sl", "en").
//   "none"   -- no speech audio at all; the director simply skips speech
//               segments and the station plays music (+ jingle). script.md
//               and transcripts still record the rendered lines.
//
// All provider output is normalized through ffmpeg to pcm_s16le/24kHz/mono
// -- the same codec contract Chatterbox output had -- so the director's
// plain concat-demuxer splicing of consecutive speech clips stays lossless.
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { config } from '../config/index.js';
import { createLogger } from '../lib/logger.js';
import { applyGain } from '../lib/audio.js';
import { synthesizeWithEdge } from './edgeTts.js';
import { synthesizePiper } from './piperVoice.js';

const execFileAsync = promisify(execFile);
const log = createLogger('station');

export function autoRadioEnabled() {
  return !!config.autoRadio?.enabled;
}

export function voiceMode() {
  return config.autoRadio?.voice?.mode ?? 'clips';
}

// ---------------------------------------------------------------------------
// clips provider
// ---------------------------------------------------------------------------

const CLIP_EXTENSIONS = ['.wav', '.mp3', '.ogg', '.flac', '.m4a'];

function clipCandidates(dir, slot) {
  if (!fs.existsSync(dir)) return [];
  // Numbered variants first (open-1, open-2, ...), plain <slot>.<ext> last so
  // it acts as the guaranteed fallback.
  const entries = fs.readdirSync(dir).sort();
  const pattern = new RegExp(`^${slot}-(\\d+)(${CLIP_EXTENSIONS.map(escapeRe).join('|')})$`, 'i');
  const numbered = entries.filter((e) => pattern.test(e)).sort((a, b) => {
    const na = parseInt(pattern.exec(a)[1], 10);
    const nb = parseInt(pattern.exec(b)[1], 10);
    return na - nb;
  });
  const plain = entries.find((e) => new RegExp(`^${slot}(${CLIP_EXTENSIONS.map(escapeRe).join('|')})$`, 'i').test(e));
  return [...numbered, ...(plain ? [plain] : [])].map((e) => path.join(dir, e));
}

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Same FNV-1a as templates.js -- picking clip index N with the same seed that
// picked template variant N keeps "what is written" and "what is played"
// aligned when a user records several takes of a slot.
function hash(seed) {
  let h = 0x811c9dc5;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

// Resolves the clip file for a persona+slot. Returns null when nothing
// exists (caller decides whether that's fatal -- for the director it isn't).
export function resolveClipPath(persona, slot, seed = '') {
  const clipsDirName = config.autoRadio?.voice?.clipsDir ?? 'voice-clips';
  const baseDir = path.isAbsolute(clipsDirName) ? clipsDirName : path.join(config.dataDir, clipsDirName);
  for (const dir of [path.join(baseDir, persona), path.join(baseDir, 'default')]) {
    const candidates = clipCandidates(dir, slot);
    if (candidates.length > 0) {
      const chosen = candidates.length === 1 ? candidates[0] : candidates[hash(`${persona}|${slot}|${seed}`) % candidates.length];
      log(`voice/clips: ${persona}/${slot} -> ${path.basename(chosen)}`);
      return chosen;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// pregenerated provider — uses clips from data/pre-generated/
// ---------------------------------------------------------------------------

function slugify(s) {
  return String(s ?? '').toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 60);
}

function resolvePreGeneratedClip(slot, track) {
  const preGenDir = path.join(config.dataDir, 'pre-generated');
  if (!fs.existsSync(preGenDir)) return null;

  // Track-specific slots
  if (track && (slot === 'intro' || slot === 'recap' || slot === 'quizIntro' || slot === 'quizReveal')) {
    const artistSlug = slugify(track.artist);
    const titleSlug = slugify(track.title);
    const clipSlot = slot === 'quizIntro' ? 'intro' : slot === 'quizReveal' ? 'recap' : slot;
    const fileName = `${artistSlug}_${titleSlug}_${clipSlot}.wav`;
    const filePath = path.join(preGenDir, fileName);
    if (fs.existsSync(filePath)) return filePath;
  }

  // General slots
  const generalMap = {
    open: 'general_open.wav',
    close: 'general_close.wav',
    handoff: 'general_handoff_weather.wav',
  };
  if (generalMap[slot]) {
    const filePath = path.join(preGenDir, generalMap[slot]);
    if (fs.existsSync(filePath)) return filePath;
  }

  return null;
}

// ---------------------------------------------------------------------------
// sapi + espeak providers
// ---------------------------------------------------------------------------

// piper synthesis moved to auto/piperVoice.js (P3 #15) so the on-air
// provider, pre-generate-clips.mjs and voiceStatus.js all resolve voices
// through the same code -- see that file for the piper1-gpl facts and the
// key-vs-path model semantics.

function personaVoiceSetting(persona) {
  return config.autoRadio?.voice?.personas?.[persona] ?? {};
}

async function synthesizeWithSapi(text, outPath, persona) {
  const { sapiVoice, rate } = personaVoiceSetting(persona);
  const script = [
    'Add-Type -AssemblyName System.Speech',
    '$s = New-Object System.Speech.Synthesis.SpeechSynthesizer',
    ...(sapiVoice ? [`$s.SelectVoice('${String(sapiVoice).replace(/'/g, "''")}')`] : []),
    ...(rate != null ? [`$s.Rate = ${parseInt(rate, 10) || 0}`] : []),
    "$s.SetOutputToWaveFile($env:TTS_OUT_PATH)",
    '$s.Speak($env:TTS_TEXT)',
    '$s.Dispose()',
  ].join('; ');
  await execFileAsync(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-Command', script],
    { env: { ...process.env, TTS_TEXT: text, TTS_OUT_PATH: outPath }, timeout: 120_000 }
  );
}

async function synthesizeWithEspeak(text, outPath, persona) {
  const { espeakVoice, wordsPerMinute } = personaVoiceSetting(persona);
  const voice = espeakVoice ?? config.autoRadio?.voice?.defaultEspeakVoice ?? 'sl';
  await execFileAsync(
    'espeak-ng',
    ['-v', voice, ...(wordsPerMinute ? ['-s', String(parseInt(wordsPerMinute, 10))] : []), '-w', outPath, text],
    { timeout: 120_000 }
  );
}

// Resolves `mode` (clips/piper/sapi/espeak) into a source file the normalizer can
// read. Shared by the top-level dispatch and edge's fallback path. `runner`
// is an optional test seam forwarded to the piper provider (injected
// execFile -- the other providers ignore it).
async function synthesizeWithProvider(mode, { text, outPath, persona, slot, seed, runner }) {
  if (mode === 'clips') {
    const sourcePath = resolveClipPath(persona, slot, seed);
    if (!sourcePath) {
      log(`voice/clips: no clip for ${persona}/${slot} (searched ${config.autoRadio?.voice?.clipsDir ?? 'voice-clips'}) -- skipping this speech segment.`);
      return { sourcePath: null, fromClips: true };
    }
    return { sourcePath, fromClips: true };
  }
  if (mode === 'sapi') {
    const sourcePath = `${outPath}.sapi-src.wav`;
    await synthesizeWithSapi(text, sourcePath, persona);
    return { sourcePath, fromClips: false };
  }
  if (mode === 'espeak') {
    const sourcePath = `${outPath}.espeak-src.wav`;
    await synthesizeWithEspeak(text, sourcePath, persona);
    return { sourcePath, fromClips: false };
  }
  if (mode === 'piper') {
    const sourcePath = `${outPath}.piper-src.wav`;
    await synthesizePiper(text, sourcePath, persona, runner ? { runner } : {});
    return { sourcePath, fromClips: false };
  }
  throw new Error(`Unknown voice provider "${mode}" (expected clips, sapi, espeak, or piper).`);
}

// ---------------------------------------------------------------------------
// unified entry -- what director/djAudio.js and prewarmAudio.js call
// ---------------------------------------------------------------------------

// Renders one speech segment to `outPath` (always a normalized wav), or
// returns false when the segment should be skipped (missing clip in clips
// mode, or mode "none"). `slot` is what clips mode keys the file by
// (open/intro/recap/quizIntro/quizReveal/handoff/close or live:<kind>);
// sapi/espeak speak `text` and only use the persona for voice selection.
export async function synthesizeNoModelSpeech({ persona, slot, text, outPath, seed = '', track = null, runner = null }) {
  const mode = voiceMode();
  if (mode === 'none') return false;

  let sourcePath = null;
  let wroteViaProvider = false;
  let fromClips = false;

  if (mode === 'clips' || mode === 'sapi' || mode === 'espeak' || mode === 'piper') {
    ({ sourcePath, fromClips } = await synthesizeWithProvider(mode, { text, outPath, persona, slot, seed, runner }));
    if (!sourcePath) return false;
    wroteViaProvider = !fromClips;
  } else if (mode === 'edge') {
    sourcePath = `${outPath}.edge-src.mp3`;
    try {
      await synthesizeWithEdge(text, sourcePath, persona);
      wroteViaProvider = true;
    } catch (err) {
      log(`voice/edge: synthesis failed (${err.message})`);
      fs.rmSync(sourcePath, { force: true });
      const fallback = config.autoRadio?.voice?.edgeFallback ?? 'none';
      if (fallback === 'none') {
        log('voice/edge: no edgeFallback configured -- skipping this speech segment.');
        return false;
      }
      log(`voice/edge: falling back to "${fallback}" for this segment.`);
      ({ sourcePath, fromClips } = await synthesizeWithProvider(fallback, { text, outPath, persona, slot, seed, runner }));
      if (!sourcePath) return false;
      wroteViaProvider = !fromClips;
    }
  } else if (mode === 'pregenerated') {
    // Pre-generated clips are keyed by slot (+track for intro/recap-style
    // slots) under dataDir/pre-generated -- a resolved clip behaves exactly
    // like a clips-mode file (no gain, no provider temp to clean). A missing
    // clip skips the segment, like a missing clip in clips mode.
    sourcePath = resolvePreGeneratedClip(slot, track);
    if (!sourcePath) {
      log(`voice/pregenerated: no pre-generated clip for slot "${slot}"${track ? ` (track: ${track.artist} - ${track.title})` : ''} -- skipping this speech segment.`);
      return false;
    }
    fromClips = true;
  } else {
    throw new Error(`Unknown autoRadio.voice.mode "${mode}" (expected clips, edge, pregenerated, piper, sapi, espeak, or none).`);
  }

  try {
    // Normalize to the Chatterbox codec contract (pcm_s16le, 24kHz, mono) so
    // downstream concat/annotation logic is format-agnostic; gain matches the
    // Chatterbox path's treatment (user-recorded clips stay untouched).
    const tmp = `${outPath}.norm.wav`;
    await execFileAsync('ffmpeg', [
      '-y', '-i', sourcePath,
      '-ar', '24000', '-ac', '1', '-c:a', 'pcm_s16le',
      tmp,
    ]);
    const gain = fromClips ? null : (config.djDrops?.gain ?? 1);
    if (gain && gain !== 1) {
      const amplified = await applyGain(fs.readFileSync(tmp), gain, config.dataDir);
      fs.writeFileSync(outPath, amplified);
      fs.rmSync(tmp, { force: true });
    } else {
      fs.renameSync(tmp, outPath);
    }
  } finally {
    if (wroteViaProvider) fs.rmSync(sourcePath, { force: true });
  }

  return true;
}
