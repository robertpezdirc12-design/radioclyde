// Voice + script status for the studio (issue #2 section B.5: manage
// EXISTING deterministic scripts and pre-generated voice clips, their
// activation, schedule, and failure state -- "Do not add AI-generated
// content"). Read-only by design: switching voice modes means editing
// config.json and restarting the service, which the studio deliberately
// does not do behind the operator's back -- the view states that gap
// instead of faking an "activate" button.
//
// Everything reported here is a real filesystem/config fact: which provider
// mode is active, whether the piper binary/model paths resolve, how many
// persona clips and pre-generated slots exist on disk.
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config/index.js';

const KNOWN_MODES = ['clips', 'pregenerated', 'piper', 'edge', 'espeak', 'sapi', 'none'];

export function activeVoiceMode() {
  return config.autoRadio?.voice?.mode ?? 'clips';
}

function dirListing(dir) {
  try {
    return fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return null; // missing dir is a normal state (nothing generated yet)
  }
}

// Persona clip inventory: <dataDir>/<clipsDir>/<persona>/<slot>.wav, the
// layout voice.js's clips provider resolves.
export function clipInventory() {
  const clipsDirName = config.autoRadio?.voice?.clipsDir ?? 'voice-clips';
  const baseDir = path.isAbsolute(clipsDirName) ? clipsDirName : path.join(config.dataDir, clipsDirName);
  const personas = {};
  let total = 0;
  const entries = dirListing(baseDir);
  if (entries) {
    for (const ent of entries) {
      if (!ent.isDirectory()) continue;
      const files = dirListing(path.join(baseDir, ent.name)) ?? [];
      const wavs = files.filter((f) => f.isFile() && /\.(wav|mp3)$/i.test(f.name)).map((f) => f.name);
      personas[ent.name] = wavs;
      total += wavs.length;
    }
  }
  return { dir: baseDir, exists: entries !== null, personas, totalClips: total };
}

// Pregenerated provider inventory: <dataDir>/pre-generated/*.wav with the
// fixed general slot names voice.js resolves (general_open / general_close /
// general_handoff_weather) plus per-track artist_title_slot clips.
export function preGeneratedInventory() {
  const dir = path.join(config.dataDir, 'pre-generated');
  const entries = dirListing(dir);
  const GENERAL = ['general_open.wav', 'general_close.wav', 'general_handoff_weather.wav'];
  let files = [];
  if (entries) files = entries.filter((f) => f.isFile() && /\.wav$/i.test(f.name)).map((f) => f.name);
  return {
    dir,
    exists: entries !== null,
    totalClips: files.length,
    generalSlots: Object.fromEntries(GENERAL.map((g) => [g, files.includes(g)])),
    trackClips: files.filter((f) => !GENERAL.includes(f)).length,
  };
}

// Piper provider readiness: the python entrypoint + default model path,
// resolved EXACTLY the way voice.js's synthesizeWithPiper does (model path
// relative to process.cwd()), plus per-persona overrides. We report whether
// the files resolve -- actually invoking python to probe would cost seconds
// per view and could hang on a broken interpreter; the on-air path logs its
// own failures loudly to logs/station.log, which Diagnostics surfaces.
export function piperStatus() {
  const voice = config.autoRadio?.voice ?? {};
  const pythonPath = voice.pythonPath ?? (process.platform === 'win32' ? 'C:/Program Files/Python311/python.exe' : 'python3');
  const configured = voice.defaultPiperVoice ?? 'voices/sl_SI-artur-medium.onnx';
  const modelPath = path.isAbsolute(configured) ? configured : path.join(process.cwd(), configured);
  const personas = Object.fromEntries(
    Object.entries(voice.personas ?? {}).map(([name, p]) => [
      name,
      {
        piperVoice: p.piperVoice ?? null,
        piperSpeaker: p.piperSpeaker ?? null,
        modelExists: p.piperVoice
          ? fs.existsSync(path.isAbsolute(p.piperVoice) ? p.piperVoice : path.join(process.cwd(), p.piperVoice))
          : null,
      },
    ])
  );
  return {
    pythonPath,
    defaultVoice: configured,
    modelExists: fs.existsSync(modelPath),
    modelPath,
    personas,
  };
}

export function voiceStatus() {
  const mode = activeVoiceMode();
  return {
    mode,
    knownModes: KNOWN_MODES,
    readonlyNote:
      'Glasovni način se preklopi z urejanjem config.json (autoRadio.voice.mode) in ponovnim zagonom storitve -- studio ga ne spreminja brez znanega razloga.',
    edge: {
      defaultVoice: config.autoRadio?.voice?.edgeVoice ?? null,
      fallback: config.autoRadio?.voice?.edgeFallback ?? null,
    },
    espeak: { defaultVoice: config.autoRadio?.voice?.defaultEspeakVoice ?? null },
    clips: clipInventory(),
    pregenerated: preGeneratedInventory(),
    piper: piperStatus(),
  };
}
