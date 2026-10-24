// Piper voice resolution + synthesis -- ONE source of truth for the three
// call sites: auto/voice.js (on-air piper provider), pre-generate-clips.mjs
// (bulk pregeneration) and server/voiceStatus.js (studio readiness view).
//
// Runtime: piper1-gpl (OHF-Voice/piper1-gpl, GPL-3.0-or-later) -- the
// maintained successor of the archived rhasspy/piper (archived 6. 10. 2025),
// shipped on PyPI as "piper-tts" (v1.8.0). Verified 2026-10-24 from the
// v1.8.0 source (src/piper/__main__.py, src/piper/download_voices.py) and
// LIVE in a clean container:
//   - `python3 -m piper -m <model> -f <out.wav> --input-file <txt>` -- the
//     SAME flags the old piper used, so existing .onnx-path configs keep
//     working unchanged;
//   - `-m` also accepts a VOICE KEY (e.g. "sl_SI-artur-medium"): piper then
//     looks for <key>.onnx in --data-dir (whose default is the current
//     working directory -- we always pass our own, under dataDir). There is
//     NO auto-download: a missing key fails with "Unable to find voice";
//   - voices download EXPLICITLY: `python3 -m piper.download_voices <key>
//     --data-dir <dir>` fetches <key>.onnx + <key>.onnx.json from
//     huggingface.co/rhasspy/piper-voices;
//   - the wheel's only runtime deps are onnxruntime + pathvalidate (the
//     phonemizer is bundled) -- no system espeak-ng needed;
//   - output is 16-bit PCM mono at the model's own rate (sl_SI-artur-medium:
//     22050 Hz); auto/voice.js normalizes to the 24 kHz codec contract.
// Slovenian voice: sl_SI-artur-medium is REAL (HF resolve returns 200 for
// both .onnx and .onnx.json, 63 MB); "arturov" does not exist.
// License note (analysis §4.7): MIT -> GPL affects embedding/predistribution,
// not calling the CLI as a separate process from Node.
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { config } from '../config/index.js';
import { createLogger } from '../lib/logger.js';

const execFileAsync = promisify(execFile);
const log = createLogger('station');

// Kept in path form so an existing zero-config box keeps resolving the same
// file it always did (voices/ is gitignored -- uploaded separately). New
// deployments should prefer the key form, e.g. "sl_SI-artur-medium".
export const PIPER_DEFAULT_MODEL = 'voices/sl_SI-artur-medium.onnx';

export function piperPythonPath() {
  return config.autoRadio?.voice?.pythonPath ?? (process.platform === 'win32' ? 'C:/Program Files/Python311/python.exe' : 'python3');
}

// Where voice-key lookups and downloads live. piper1-gpl's own default is
// the process working directory, which pollutes the repo root -- we keep
// station data under dataDir instead (same home as voice-clips and
// pre-generated). Relative config values resolve against cwd, like the
// old provider's model paths.
export function piperDataDir() {
  const dir = config.autoRadio?.voice?.piperDataDir ?? path.join(config.dataDir, 'piper');
  return path.isAbsolute(dir) ? dir : path.join(process.cwd(), dir);
}

// A model spec is a piper1-gpl voice KEY unless it names an .onnx file
// (the old rhasspy-piper style).
export function isPiperVoiceKey(model) {
  return !/\.onnx$/i.test(String(model ?? ''));
}

// Resolves the model spec for `persona` (persona override > station default
// > built-in default) into everything synthesis and status need. Key form
// resolves to <dataDir>/<key>.onnx so status and download checks look in
// the SAME place piper1-gpl will; path form resolves relative to
// process.cwd() exactly like the old provider did.
export function resolvePiperVoice(persona) {
  const personaCfg = config.autoRadio?.voice?.personas?.[persona] ?? {};
  const model = personaCfg.piperVoice ?? config.autoRadio?.voice?.defaultPiperVoice ?? PIPER_DEFAULT_MODEL;
  const isKey = isPiperVoiceKey(model);
  const dataDir = piperDataDir();
  const modelPath = isKey
    ? path.join(dataDir, `${model}.onnx`)
    : (path.isAbsolute(model) ? model : path.join(process.cwd(), model));
  return { model, isKey, dataDir, modelPath };
}

// argv for `python3 -m piper ...` -- identical for both runtime generations
// (old piper and piper1-gpl); --data-dir only matters for key lookups.
export function buildPiperArgs({ model, isKey, dataDir, textFile, outPath, speaker, lengthScale }) {
  const args = ['-m', 'piper', '-m', model];
  if (isKey) args.push('--data-dir', dataDir);
  args.push('-f', outPath, '--input-file', textFile);
  if (speaker != null) args.push('--speaker', String(speaker));
  // P4 #26 prosody knob (research pass: pace IS naturalness -- slightly
  // slower delivery reads as calm and human; <1 speeds up, >1 slows down).
  // Omitted entirely at the default 1 so no flag changes existing behavior.
  if (lengthScale != null && Number(lengthScale) !== 1) args.push('--length-scale', String(Number(lengthScale)));
  return args;
}

// Makes sure the resolved voice is actually on disk before synthesis.
// Key form: piper1-gpl never auto-downloads, so the download happens HERE,
// once, via piper.download_voices -- unless piperAutoDownload is explicitly
// false, in which case the error states the exact command the operator can
// run themselves. Path form: an honest early error instead of piper's own
// traceback.
export async function ensurePiperVoice({ model, isKey, dataDir, modelPath }, { runner = execFileAsync } = {}) {
  if (!isKey) {
    if (fs.existsSync(modelPath)) return;
    throw new Error(
      `piper model file not found: ${modelPath} -- place the .onnx (+ .onnx.json) there, ` +
      `or set autoRadio.voice.defaultPiperVoice to a piper1-gpl voice key like "sl_SI-artur-medium"`
    );
  }
  if (fs.existsSync(modelPath)) return;
  if (config.autoRadio?.voice?.piperAutoDownload === false) {
    throw new Error(
      `piper1-gpl voice "${model}" not found in ${dataDir} -- download it with: ` +
      `python3 -m piper.download_voices ${model} --data-dir ${dataDir} (or set autoRadio.voice.piperAutoDownload=true)`
    );
  }
  fs.mkdirSync(dataDir, { recursive: true });
  const timeoutMs = config.autoRadio?.voice?.piperDownloadTimeoutMs ?? 600_000;
  log(`voice/piper: voice key "${model}" not in ${dataDir} -- downloading via piper.download_voices (one-time, a medium voice is ~60 MB)`);
  await runner(piperPythonPath(), ['-m', 'piper.download_voices', model, '--data-dir', dataDir], { timeout: timeoutMs });
  if (!fs.existsSync(modelPath)) {
    throw new Error(`piper.download_voices finished but ${modelPath} is still missing -- check logs/station.log for the download output`);
  }
  log(`voice/piper: voice "${model}" downloaded to ${dataDir}`);
}

// Synthesizes `text` with `persona`'s piper voice and writes WAV bytes to
// `outPath`. Throws on any failure -- the caller owns fallback policy.
// `runner` is injectable for tests (default: the real execFile).
export async function synthesizePiper(text, outPath, persona, { runner = execFileAsync } = {}) {
  const resolved = resolvePiperVoice(persona);
  await ensurePiperVoice(resolved, { runner });
  // Write text to a temp file to avoid shell escaping issues with Slovenian chars.
  const textFile = `${outPath}.piper-text.txt`;
  fs.writeFileSync(textFile, text, 'utf8');
  const timeoutMs = config.autoRadio?.voice?.piperTimeoutMs ?? 120_000;
  const args = buildPiperArgs({
    ...resolved,
    textFile,
    outPath,
    speaker: config.autoRadio?.voice?.personas?.[persona]?.piperSpeaker ?? null,
    // P4 #26: per-persona override first, global fallback, undefined = flag omitted.
    lengthScale: config.autoRadio?.voice?.personas?.[persona]?.piperLengthScale
      ?? config.autoRadio?.voice?.piperLengthScale ?? null,
  });
  try {
    await runner(piperPythonPath(), args, { timeout: timeoutMs });
    const bytes = fs.existsSync(outPath) ? fs.statSync(outPath).size : 0;
    if (bytes === 0) {
      throw new Error(`piper produced no audio for persona "${persona}" (${resolved.isKey ? `voice key ${resolved.model}` : resolved.modelPath})`);
    }
    log(`voice/piper: ${persona} <- ${resolved.isKey ? `${resolved.model} (piper1-gpl key)` : resolved.modelPath}, ${bytes} bytes`);
  } finally {
    // Audit 2026-10-24: cleanup must run on failure too -- every failed
    // synthesis (missing piper module, bad model path, timeout) must not
    // leak a .piper-text.txt next to the output, one per retry per segment.
    fs.rmSync(textFile, { force: true });
  }
}
