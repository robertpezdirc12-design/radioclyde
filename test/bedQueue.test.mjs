// Tests for P3 #12/#13 -- beds ("postelje"): announcements OVER the music
// via the sidechain ducker (radio.liq) + a request.queue(id="beds") fed by
// telnet pushes (src/liquidsoap/bedQueue.js). Two layers, mirroring the
// feature: the radio.liq wiring (structural, same pattern as
// requestQueue.test.mjs -- Liquidsoap can't run in CI) and the three telnet
// actions against a FAKE server speaking Liquidsoap's real wire protocol
// (command -> response + END).
//
// Wire shapes follow the v2.2.4 source verified in src/libs/request.liq
// (push -> numeric id, queue -> space-separated ids, skip -> "Done.") and
// src/core/tools/server.ml (command/args split at the FIRST space, so paths
// with spaces survive; "ERROR: ..." strings are never success).
// P3 #13 replaced #12's smooth_add mixing with a stdlib-native ducker
// (rms.smooth + source.on_frame + amplify getter -- the exact mechanism
// this build's normalize() uses); the telnet layer is byte-identical.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';

import { setupTestConfig, writeWav, repoRoot } from './fixtures.mjs';

setupTestConfig('bed-queue', {});

const { pushBedFile, queueBeds, skipBed, ensureBedsLeadIn } = await import('../src/liquidsoap/bedQueue.js');
const { config: liveConfig } = await import('../src/config/index.js');

// ---------------------------------------------------------------------------
// radio.liq structural wiring
// ---------------------------------------------------------------------------

const liqRaw = fs.readFileSync(path.join(repoRoot(), 'liquidsoap', 'radio.liq'), 'utf8');
const liq = liqRaw
  .split('\n')
  .map((line) => line.replace(/#.*$/, ''))
  .join('\n');

describe('radio.liq beds wiring (P3 #13 sidechain ducker)', () => {
  test('beds request.queue exists and the ducker mixes it over the program', () => {
    assert.match(liq, /beds_source = request\.queue\(id="beds"\)/);
    assert.match(liq, /beds_rms = rms\.smooth\(duration=0\.05, beds_source\)/);
    assert.match(liq, /radio = add\(normalize=false, \[radio, amplify\(0\.8, beds_rms\)\]\)/);
  });

  test('P3 #12 smooth_add is fully superseded -- no smooth_add wiring left', () => {
    // The ducker replaced smooth_add everywhere in this script; a leftover
    // would mean two competing mixers over the same beds queue.
    assert.doesNotMatch(liq, /smooth_add/);
  });

  test('ducker state machine: is_ready gate, hysteresis literals, attack/release constants', () => {
    // is_ready gate: rms.smooth stops being pulled (and its .rms freezes at
    // the last spoken value) once the beds queue empties -- without the gate
    // the program would stay ducked forever after a clip ends.
    assert.match(liq, /level = if source\.is_ready\(beds_source\) then beds_rms\.rms\(\) else 0\. end/);
    // Hysteresis: duck at -34 dB RMS, release below -42 dB, hold in between.
    assert.match(liq, /if level >= 0\.02 then 0\.2\n\s*elsif level >= 0\.008 then duck_gain\(\)/);
    // Attack/release time constants, same exponential form normalize() uses.
    assert.match(liq, /duck_attack = 1\. - exp\(0\. - frame\.duration\(\) \/ 0\.02\)/);
    assert.match(liq, /duck_release = 1\. - exp\(0\. - frame\.duration\(\) \/ 0\.5\)/);
    assert.match(liq, /duck_gain := duck_gain\(\) \+ duck_coef \* \(duck_target - duck_gain\(\)\)/);
  });

  test('duck amplifier is getter-driven with override=null(), upstream of the R128 amplify', () => {
    // override=null() is load-bearing: with the default "liq_amplify" field
    // (amplify.ml) this amplifier would swallow each track's R128 correction
    // at track start AND freeze its own gain for that track.
    assert.match(liq, /radio = amplify\(id="beds-duck", override=null\(\), \{duck_gain\(\)\}, radio\)/);
    assert.match(liq, /amplify\(override="liq_amplify", 1\., radio\)/);
    const duckAt = liq.indexOf('amplify(id="beds-duck"');
    const r128At = liq.indexOf('amplify(override="liq_amplify"');
    assert.ok(duckAt !== -1 && r128At !== -1 && duckAt < r128At, 'duck amplifier sits upstream of the R128 one');
  });

  test('on_frame updater drives the gain ref before the amplifier applies it', () => {
    // stdlib normalize() ordering: on_frame updates the ref, the amplify
    // getter reads it -- one frame of lag, the same accepted cost.
    const onFrameAt = liq.indexOf('radio = source.on_frame(radio, duck_update)');
    const ampAt = liq.indexOf('radio = amplify(id="beds-duck"');
    assert.ok(onFrameAt !== -1 && ampAt !== -1 && onFrameAt < ampAt);
  });

  test('ducker sits above the ID overlay and the requests layer, below the dead-air guard', () => {
    const duckerAt = liq.indexOf('radio = add(normalize=false, [radio, amplify(0.8, beds_rms)])');
    const idAt = liq.indexOf('add([radio, switch([({0m0s}, id_source)])])');
    const requestsAt = liq.indexOf('fallback(track_sensitive=true, [requests_source, radio])');
    const detectAt = liq.indexOf('blank.detect(dead_air_program');
    assert.ok(duckerAt !== -1, 'ducker mix line present');
    assert.ok(idAt !== -1 && requestsAt !== -1 && detectAt !== -1, 'reference layers present');
    assert.ok(duckerAt > idAt, 'an announcement outranks the hour ID overlay');
    assert.ok(duckerAt > requestsAt, 'an announcement rides over a listener request too');
    assert.ok(duckerAt < detectAt, 'the program dead-air observer sees the MIXED output');
  });

  test('beds compressor (SUB/WAVE mic_chain) is %ifdef-gated, mix line intact either way', () => {
    // %ifdef compress = the honest gate: the operator ships only with
    // liquidsoap-libs-extra, so a build without it must boot byte-identically
    // (the %else branch keeps the exact old mix line).
    assert.match(liq, /%ifdef compress\nbeds_chain = compress\(attack=5\.0, release=120\.0, threshold=-18\.0, ratio=4\.0, knee=2\.0, gain=0\.0, beds_rms\)/);
    assert.match(liq, /radio = add\(normalize=false, \[radio, amplify\(0\.8, beds_chain\)\]\)/);
    // No makeup gain: subwave's gain=7.0 + amplify(1.4) is live-mic territory;
    // our beds are produced clips -- makeup into add() would clip the mix.
    assert.doesNotMatch(liq, /amplify\(1\.4/);
    assert.doesNotMatch(liq, /gain=7\.0/);
  });

  test('broadcast bus limiter (SUB/WAVE) is %ifdef-gated and sits between the air guard and the outputs', () => {
    assert.match(liq, /%ifdef compress\nradio = compress\(attack=1\.0, release=80\.0, threshold=-1\.0, ratio=20\.0, knee=0\.5, gain=0\.0, radio\)/);
    const guardAt = liq.indexOf('blank.detect(dead_air_total');
    const limiterAt = liq.indexOf('radio = compress(attack=1.0');
    const outputAt = liq.indexOf('output.icecast(%mp3(bitrate=config.icecast.bitrate)');
    assert.ok(guardAt !== -1 && limiterAt !== -1 && outputAt !== -1, 'chain anchors present');
    assert.ok(guardAt < limiterAt, 'dead-air observers see pre-limiter frames');
    assert.ok(limiterAt < outputAt, 'the limiter is the last operator before the encoder');
  });

  test('program core and safety net untouched', () => {
    assert.match(liq, /fallback\(track_sensitive=false, \[show_source, filler_source\]\)/);
    assert.match(liq, /mksafe\(fallback\(track_sensitive=false, \[radio, emergency_source\]\)\)/);
    assert.match(liq, /amplify\(override="liq_amplify", 1\., radio\)/);
  });
});

// ---------------------------------------------------------------------------
// fake Liquidsoap telnet + the three actions
// ---------------------------------------------------------------------------

function startFakeLiquidsoap(responder) {
  return new Promise((resolve) => {
    const server = net.createServer((socket) => {
      socket.on('data', (chunk) => {
        for (const cmd of chunk.toString('utf8').split('\n')) {
          const line = cmd.trim();
          if (!line || line === 'quit') continue;
          socket.write(`${responder(line)}\nEND\n`);
        }
      });
    });
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });
}

const bedsDir = path.join(liveConfig.dataDir, 'beds');
fs.mkdirSync(bedsDir, { recursive: true });
const BED_CLIP = writeWav(path.join(bedsDir, 'vreme 24.10.wav'), 2);

describe('pushBedFile (fake Liquidsoap telnet)', () => {
  test('pushes an absolute path and accepts the numeric reply', async () => {
    let seen = null;
    const fake = await startFakeLiquidsoap((cmd) => {
      seen = cmd;
      return '9';
    });
    liveConfig.liquidsoap.telnetPort = fake.port;
    try {
      const outcome = await pushBedFile(BED_CLIP);
      assert.equal(outcome.ok, true);
      assert.equal(outcome.requestId, '9');
      assert.equal(seen, `beds.push ${BED_CLIP}`, 'absolute path, first-space split keeps the spaces');
      assert.equal(path.isAbsolute(outcome.localPath), true);
    } finally {
      fake.server.close();
    }
  });

  test('a relative path is resolved to absolute before the push', async () => {
    let seen = null;
    const fake = await startFakeLiquidsoap((cmd) => {
      seen = cmd;
      return '10';
    });
    liveConfig.liquidsoap.telnetPort = fake.port;
    try {
      // cwd of a node --test run is the repo root; the relative dataDir path
      // must still reach Liquidsoap as a resolvable absolute path (LS
      // resolves pushed URIs against ITS OWN cwd, not ours).
      const relative = path.relative(process.cwd(), BED_CLIP);
      const outcome = await pushBedFile(relative);
      assert.equal(outcome.ok, true);
      assert.equal(seen, `beds.push ${BED_CLIP}`);
    } finally {
      fake.server.close();
    }
  });

  test('a non-numeric reply is surfaced as failure, never treated as queued', async () => {
    const fake = await startFakeLiquidsoap(() => 'ERROR: queue is full');
    liveConfig.liquidsoap.telnetPort = fake.port;
    try {
      const outcome = await pushBedFile(BED_CLIP);
      assert.equal(outcome.ok, false);
      assert.match(outcome.error, /ERROR: queue is full/);
    } finally {
      fake.server.close();
    }
  });

  test('missing file: honest local error, no telnet call at all', async () => {
    // A port with no listener: if the module ever tried to connect, this
    // would throw a connection error instead of the file error.
    const dead = await startFakeLiquidsoap(() => '');
    const port = dead.port;
    dead.server.close();
    liveConfig.liquidsoap.telnetPort = port;
    const outcome = await pushBedFile(path.join(bedsDir, 'ne-obstaja.wav'));
    assert.equal(outcome.ok, false);
    assert.match(outcome.error, /ne obstaja/);
  });
});

describe('queueBeds + skipBed (fake Liquidsoap telnet)', () => {
  test('queue lists numeric ids; empty reply is an honest empty queue', async () => {
    let phase = 'busy';
    const fake = await startFakeLiquidsoap((cmd) => {
      assert.equal(cmd, 'beds.queue');
      return phase === 'busy' ? '3 4' : '';
    });
    liveConfig.liquidsoap.telnetPort = fake.port;
    try {
      const busy = await queueBeds();
      assert.deepEqual(busy.queue, ['3', '4']);
      phase = 'idle';
      const idle = await queueBeds();
      assert.deepEqual(idle.queue, []);
    } finally {
      fake.server.close();
    }
  });

  test('skip accepts "Done.", surfaces anything else', async () => {
    let phase = 'ok';
    const fake = await startFakeLiquidsoap((cmd) => {
      assert.equal(cmd, 'beds.skip');
      return phase === 'ok' ? 'Done.' : 'ERROR: not the special source right now';
    });
    liveConfig.liquidsoap.telnetPort = fake.port;
    try {
      const ok = await skipBed();
      assert.equal(ok.ok, true);
      phase = 'bad';
      const bad = await skipBed();
      assert.equal(bad.ok, false);
      assert.match(bad.error, /ERROR: not the special source/);
    } finally {
      fake.server.close();
    }
  });
});

// ---------------------------------------------------------------------------
// tih uvod (lead-in, SUB/WAVE 1722-1746 adapted to the RMS-keyed ducker)
// ---------------------------------------------------------------------------

// Fake ffmpeg: "runs" by writing a real (tiny) WAV to the output path the
// real runner would have produced. The real binary is exercised separately
// below, gated on its presence.
const fakeRunnerOk = async (cmd, args) => {
  writeWav(args[args.length - 1], 1);
  return { stdout: '' };
};
const fakeRunnerFails = async () => {
  throw new Error('ffmpeg ni na voljo');
};

describe('ensureBedsLeadIn + pushBedFile lead-in (fake telnet)', () => {
  const leadInPath = path.join(liveConfig.dataDir, 'beds-leadin.wav');

  // Vsak test začne s SVEŽIM stanjem diska: predhodni push-testi (nadalje z
  // realnim ffmpeg) že pustijo beds-leadin.wav v dataDir, cache na disku pa
  // je ravno tako del pogodbe, da ga moramo za preizkus generiranja
  // izrecno počistiti.
  const freshLeadIn = () => {
    try { fs.unlinkSync(leadInPath); } catch { /* ni ga */ }
  };

  test('generates the lead-in once into dataDir and caches it on disk', async () => {
    freshLeadIn();
    let calls = 0;
    const counting = async (cmd, args) => {
      calls += 1;
      writeWav(args[args.length - 1], 1);
      return { stdout: '' };
    };
    const first = await ensureBedsLeadIn({ runner: counting });
    assert.equal(first, leadInPath);
    assert.equal(calls, 1);
    // Drugi klic vidi datoteko na disku in ffmpeg-a več ne pokliče.
    const second = await ensureBedsLeadIn({ runner: counting });
    assert.equal(second, leadInPath);
    assert.equal(calls, 1);
    assert.ok(fs.statSync(leadInPath).size > 1000, 'writeWav naredi dovolj veliko datoteko za cachne pogoj');
  });

  test('generation failure returns null honestly (bed still pushes without it)', async () => {
    freshLeadIn();
    const fake = await startFakeLiquidsoap(() => '7');
    liveConfig.liquidsoap.telnetPort = fake.port;
    try {
      const outcome = await pushBedFile(BED_CLIP, { runner: fakeRunnerFails });
      assert.equal(outcome.ok, true);
      assert.equal(outcome.leadIn, false, 'uvod se ni zgeneriral -> prizadevno poročano');
      assert.equal(outcome.requestId, '7');
    } finally {
      fake.server.close();
    }
  });

  test('lead-in is pushed BEFORE the bed, and {leadIn:true} reports it', async () => {
    const seenCommands = [];
    const fake = await startFakeLiquidsoap((cmd) => {
      seenCommands.push(cmd);
      return String(seenCommands.length + 20);
    });
    liveConfig.liquidsoap.telnetPort = fake.port;
    try {
      const outcome = await pushBedFile(BED_CLIP, { runner: fakeRunnerOk });
      assert.equal(outcome.ok, true);
      assert.equal(outcome.leadIn, true);
      assert.equal(seenCommands.length, 2, 'natanko dva pusha: uvod + postelja');
      assert.equal(seenCommands[0], `beds.push ${leadInPath}`, 'uvod gre PRVI');
      assert.equal(seenCommands[1], `beds.push ${BED_CLIP}`, 'postelja gre druga');
    } finally {
      fake.server.close();
    }
  });

  test('a refused lead-in (ERROR reply) never blocks the bed', async () => {
    const fake = await startFakeLiquidsoap((cmd) => {
      // Uvod (edina komanda, ki omenja beds-leadin) dobi napako, postelja ne.
      return cmd.includes('beds-leadin.wav') ? 'ERROR: nope' : '31';
    });
    liveConfig.liquidsoap.telnetPort = fake.port;
    try {
      const outcome = await pushBedFile(BED_CLIP, { runner: fakeRunnerOk });
      assert.equal(outcome.ok, true);
      assert.equal(outcome.leadIn, false, 'zavrnjen uvod ni lažno prijavljen');
      assert.equal(outcome.requestId, '31');
    } finally {
      fake.server.close();
    }
  });

  test('{ leadIn:false } skips the lead-in entirely (opt-out)', async () => {
    const seenCommands = [];
    const fake = await startFakeLiquidsoap((cmd) => {
      seenCommands.push(cmd);
      return '5';
    });
    liveConfig.liquidsoap.telnetPort = fake.port;
    try {
      const outcome = await pushBedFile(BED_CLIP, { leadIn: false, runner: fakeRunnerOk });
      assert.equal(outcome.ok, true);
      assert.equal(outcome.leadIn, false);
      assert.deepEqual(seenCommands, [`beds.push ${BED_CLIP}`], 'samo postelja, brez uvoda');
    } finally {
      fake.server.close();
    }
  });

  test('REAL ffmpeg integration (skips honestly when ffmpeg is absent)', { timeout: 20_000 }, async (t) => {
    let ffmpegPresent = true;
    try {
      const { execFile } = await import('node:child_process');
      const { promisify } = await import('node:util');
      await promisify(execFile)('ffmpeg', ['-version']);
    } catch {
      ffmpegPresent = false;
    }
    if (!ffmpegPresent) {
      t.skip('ffmpeg ni na voljo na tem stroju -- preskočeno pošteno');
      return;
    }
    // Zgeneriraj sveč (izbriši morebitni iz prejšnjih testov), da vidimo
    // PRAVI nastavek, potem pa preveri dolžino z ffprobe-jem.
    try { fs.unlinkSync(leadInPath); } catch { /* ni ga */ }
    const generated = await ensureBedsLeadIn({});
    assert.equal(generated, leadInPath);
    assert.ok(fs.statSync(leadInPath).size > 100_000, 'resnični stereo WAV ~141 kB, ne kostur');
    const { execFile } = await import('node:child_process');
    const { promisify } = await import('node:util');
    const execFileAsync = promisify(execFile);
    const { stdout } = await execFileAsync('ffprobe', [
      '-v', 'error', '-show_entries', 'format=duration',
      '-of', 'default=noprint_wrappers=1:nokey=1', leadInPath,
    ]);
    const duration = parseFloat(stdout);
    assert.ok(Math.abs(duration - 0.8) < 0.05, `trajanje ~0,8 s (dobljeno ${duration})`);
    // Kalibracijska trdnost: RMS mora biti nad pragom duhanja 0,02 (-34 dB),
    // da uvod sploh prizhene duker -- pod pragom bi bil tiha ovira.
    const stats = await execFileAsync('ffmpeg', [
      '-i', leadInPath, '-af', 'astats=metadata=0', '-f', 'null', '-',
    ]).catch(() => ({ stderr: '' }));
    const rmsDb = parseFloat((stats.stderr.match(/RMS level dB: (-?[\d.]+)/) || [])[1]);
    assert.ok(Number.isFinite(rmsDb) && rmsDb > -34 && rmsDb < -28, `RMS ~-30 dBFS (dobljeno ${rmsDb}) -- nad pragom duhanja, pod slišnostjo`);
  });
});
