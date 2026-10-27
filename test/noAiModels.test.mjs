// The Val 28 directive, made permanent: "samo skripte brez AI modelov" --
// ONLY scripts, NO AI models anywhere in the station. This file is the
// guardrail that keeps that true: if anyone reintroduces an LLM client, a
// self-hosted AI TTS, or the config blocks that pointed at them, a test
// here fails BEFORE the code ever reaches the air.
//
//   A. the AI layer's files do not exist (src/llm/, the Chatterbox TTS
//      client + its systemd restarter, the LLM move/review/research/query
//      producer modules, the AI preview CLIs),
//   B. no source file under src/ (nor the repo-root CLI scripts) imports
//      the removed modules or touches their config keys,
//   C. the shipped config.example.json carries no lmStudio/chatterbox
//      blocks and no autoRadio.enabled flag,
//   D. the producer/director entry points route everything through the
//      deterministic pipeline (generateScript -> runAutoProducerPipeline,
//      liveSegments -> resolveLiveLineAuto, djAudio -> the no-model voice
//      layer) -- the mode branch itself is gone, not just defaulted.
//
// History notes in comments (WHY the layer is gone) are fine and expected;
// what this test pins is that no LIVE reference to the AI layer survives.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { repoRoot } from './fixtures.mjs';

const repo = repoRoot();

// The removed files. Each name here is a file whose COMEBACK would mean an
// AI model is back on the speech/production path.
const REMOVED_FILES = [
  'src/llm/client.js', // the LM Studio chat-completions client (qwen)
  'src/llm/prompts.js', // LLM persona + paralinguistic prompts
  'src/producer/moves.js', // LLM move generation (open/intro/recap/tease)
  'src/producer/reviewScript.js', // LLM script-review pass
  'src/producer/research/trackResearch.js', // LLM track-fact research
  'src/producer/trackSelection/query.js', // LLM track-query resolution
  'src/producer/boundaryWalk.js', // the AI-mode boundary walk
  'src/director/tts.js', // the Chatterbox TTS HTTP client
  'src/scheduler/restartChatterbox.js', // chatterbox-tts.service restarter
  'src/cli/previewShowPrep.js', // AI show-prep preview CLI
  'src/cli/previewTrackQueryAi.js', // AI track-query preview CLI
];

// Identifiers whose reappearance in shipped source means the AI layer
// crept back: import specifiers of the removed modules, the config keys
// that pointed at the model servers, and the lock path that serialized the
// single-GPU TTS. (doctor.js's legacy-key REPORTING reads the same keys off
// its own configOrError argument -- a different, deliberate spelling this
// scan does not match.)
const FORBIDDEN_SUBSTRINGS = [
  'llm/client.js',
  'llm/prompts.js',
  'restartChatterbox',
  'config.lmStudio',
  'config.chatterbox',
  'chatterboxLockPath',
];

function* walkSourceFiles(dir) {
  let names = [];
  try { names = fs.readdirSync(dir); } catch { return; }
  for (const name of names) {
    if (name === 'node_modules' || name === '.' || name.startsWith('.git')) continue;
    const full = path.join(dir, name);
    let st = null;
    try { st = fs.statSync(full); } catch { continue; }
    if (st.isDirectory()) {
      yield* walkSourceFiles(full);
    } else if (/\.(js|mjs)$/.test(name)) {
      yield full;
    }
  }
}

describe('A. the AI layer\'s files are gone', () => {
  for (const rel of REMOVED_FILES) {
    test(`${rel} does not exist`, () => {
      assert.ok(!fs.existsSync(path.join(repo, rel)), `${rel} must not come back -- samo skripte brez AI modelov`);
    });
  }
});

describe('B. no live reference to the AI layer in shipped source', () => {
  const sourceFiles = [
    ...walkSourceFiles(path.join(repo, 'src')),
    ...fs.readdirSync(repo)
      .filter((n) => n.endsWith('.mjs'))
      .map((n) => path.join(repo, n)),
  ];

  test('there is source to scan', () => {
    assert.ok(sourceFiles.length > 50, `expected the station's source tree, found ${sourceFiles.length} files`);
  });

  for (const needle of FORBIDDEN_SUBSTRINGS) {
    test(`no source file references "${needle}"`, () => {
      const offenders = sourceFiles.filter((f) => fs.readFileSync(f, 'utf8').includes(needle));
      assert.deepEqual(
        offenders.map((f) => path.relative(repo, f)),
        [],
        `"${needle}" may not reappear in shipped source`
      );
    });
  }
});

describe('C. the shipped example config is AI-free', () => {
  test('config.example.json has no lmStudio/chatterbox blocks and no autoRadio.enabled flag', () => {
    const example = JSON.parse(fs.readFileSync(path.join(repo, 'config.example.json'), 'utf8'));
    assert.ok(!('lmStudio' in example), 'the LM Studio block must be gone');
    assert.ok(!('chatterbox' in example), 'the Chatterbox block must be gone');
    assert.ok(!('enabled' in (example.autoRadio ?? {})), 'autoRadio.enabled is dead config -- the deterministic pipeline is the only pipeline');
    assert.equal(example.autoRadio?.voice?.mode, 'edge', 'the example voice is the no-model Edge layer');
  });

  test('package.json has no AI preview scripts', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(repo, 'package.json'), 'utf8'));
    const scripts = Object.keys(pkg.scripts ?? {});
    assert.ok(!scripts.includes('preview-track-query-ai'), 'the AI track-query preview is gone');
    assert.ok(!scripts.includes('preview-show-prep'), 'the AI show-prep preview is gone');
    assert.ok(!scripts.includes('preview-tracks'), 'the AI tracks alias is gone');
  });
});

describe('D. the entry points are single-pipeline, not just defaulted', () => {
  test('generateScript.js: the deterministic pipeline is the only pipeline', () => {
    const src = fs.readFileSync(path.join(repo, 'src', 'producer', 'generateScript.js'), 'utf8');
    assert.match(src, /runAutoProducerPipeline/);
    assert.ok(!src.includes('runProducerPipeline('), 'the old AI pipeline call must not survive');
    assert.ok(!src.includes('autoRadioEnabled'), 'the mode branch itself must be gone');
    assert.ok(!src.includes('config.lmStudio'), 'no model name may land in context.json');
  });

  test('liveSegments.js: the template resolver is the only path', () => {
    const src = fs.readFileSync(path.join(repo, 'src', 'director', 'liveSegments.js'), 'utf8');
    assert.match(src, /resolveLiveLineAuto/);
    assert.ok(!src.includes('autoRadioEnabled'), 'the mode branch itself must be gone');
    assert.ok(!src.includes('complete('), 'no model completion call');
  });

  test('djAudio.js: the no-model voice layer is the only synthesizer', () => {
    const src = fs.readFileSync(path.join(repo, 'src', 'director', 'djAudio.js'), 'utf8');
    assert.match(src, /synthesizeNoModelSpeech/);
    assert.ok(!src.includes('autoRadioEnabled'), 'the mode branch itself must be gone');
    assert.ok(!src.includes('synthesizeVoice'), 'the Chatterbox call must not survive');
  });

  test('scheduler.js registers no chatterbox_restart job', () => {
    const src = fs.readFileSync(path.join(repo, 'src', 'scheduler', 'scheduler.js'), 'utf8');
    assert.ok(!src.includes("'chatterbox_restart'"), 'no AI-process restart job');
    assert.ok(!src.includes('config.chatterbox'), 'the scheduler no longer reads the chatterbox block at all');
  });
});
