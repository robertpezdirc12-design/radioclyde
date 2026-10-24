// Microsoft Edge neural TTS provider -- the high-quality no-model voice for
// autoRadio mode. Uses Microsoft's Edge read-aloud service, which ships real
// neural Slovenian voices:
//
//   sl-SI-PetraNeural  (female)
//   sl-SI-RokNeural    (male)
//
// No API key, no local model, no download -- the same service the Edge
// browser's "Read aloud" feature uses. Output is MP3 at 24 kHz mono; the
// caller (auto/voice.js) normalizes it to the station's pcm_s16le/24kHz/mono
// codec contract, exactly like the espeak/SAPI providers.
//
// Caveats handled here:
//   - the service is unofficial and can rate-limit (HTTP 429) or drop the
//     WebSocket -- every failure throws, and voice.js decides (config
//     autoRadio.voice.edgeFallback) whether to fall back to espeak/SAPI/
//     clips or skip the segment;
//   - hard caps on synthesis time and payload size so a wedged socket can
//     never stall the director.
import { writeFile } from 'node:fs/promises';
import msEdgeTtsPkg from 'msedge-tts';
import { config } from '../config/index.js';
import { createLogger } from '../lib/logger.js';

const { MsEdgeTTS } = msEdgeTtsPkg;
const log = createLogger('station');

const SYNTH_TIMEOUT_MS = config.autoRadio?.voice?.edgeTimeoutMs ?? 45_000;
const MAX_AUDIO_BYTES = 10 * 1024 * 1024;

export function edgeVoiceForPersona(persona) {
  const personaCfg = config.autoRadio?.voice?.personas?.[persona] ?? {};
  return personaCfg.edgeVoice ?? config.autoRadio?.voice?.edgeVoice ?? 'sl-SI-RokNeural';
}

// P4 #26 prosody (research pass): pace and pitch ARE naturalness -- a voice
// at +0% default rate sounds fine for navigation but slightly rushed for a
// relaxed radio; operators can now slow it a touch. Persona config wins
// over global; only keys actually set are sent (empty prosody = the same
// request as before this feature).
export function edgeProsodyForPersona(persona) {
  const personaCfg = config.autoRadio?.voice?.personas?.[persona] ?? {};
  const voice = config.autoRadio?.voice ?? {};
  const prosody = {};
  for (const key of ['rate', 'pitch', 'volume']) {
    const value = personaCfg[`edge${key[0].toUpperCase()}${key.slice(1)}`] ?? voice[`edge${key[0].toUpperCase()}${key.slice(1)}`];
    if (value != null && value !== '') prosody[key] = value;
  }
  return Object.keys(prosody).length ? prosody : undefined;
}

function streamToBuffer(audioStream) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    audioStream.on('data', (chunk) => {
      total += chunk.length;
      if (total > MAX_AUDIO_BYTES) {
        audioStream.destroy();
        reject(new Error(`edge TTS payload exceeds ${MAX_AUDIO_BYTES} bytes`));
        return;
      }
      chunks.push(chunk);
    });
    audioStream.on('end', () => resolve(Buffer.concat(chunks)));
    audioStream.on('error', reject);
  });
}

function withTimeout(promise, ms, label) {
  let timer;
  const guard = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`edge TTS ${label} timed out after ${ms} ms`)), ms);
  });
  return Promise.race([promise, guard]).finally(() => clearTimeout(timer));
}

// Synthesizes `text` with `persona`'s Edge voice and writes MP3 bytes to
// `outPath`. Throws on any failure -- the caller owns fallback policy.
export async function synthesizeWithEdge(text, outPath, persona) {
  const voice = edgeVoiceForPersona(persona);
  const tts = new MsEdgeTTS();
  try {
    await withTimeout(tts.setMetadata(voice, 'audio-24khz-48kbitrate-mono-mp3'), SYNTH_TIMEOUT_MS, `connect (${voice})`);
    const prosody = edgeProsodyForPersona(persona);
    const { audioStream } = prosody ? tts.toStream(text, prosody) : tts.toStream(text);
    const mp3 = await withTimeout(streamToBuffer(audioStream), SYNTH_TIMEOUT_MS, 'synthesis');
    if (mp3.length === 0) throw new Error('edge TTS returned empty audio');
    await writeFile(outPath, mp3);
    log(`voice/edge: ${persona} <- ${voice}, ${mp3.length} bytes`);
  } finally {
    try { tts.close?.(); } catch { /* socket already gone */ }
  }
}
