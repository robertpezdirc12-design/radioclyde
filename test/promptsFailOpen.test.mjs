// Fail-open reads on a fresh deploy (Task 11-P1): scheduler/promptsUtil.js
// (dataDir/prompts.json) and server/studioShowsApi.js (show-descriptions/)
// used to answer raw 500s -- with the absolute dataDir path inside Fastify's
// error body -- the moment dataDir wasn't populated yet. These tests pin the
// honest-empty contracts and that valid files still behave identically.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import Fastify from 'fastify';

import { setupTestConfig } from './fixtures.mjs';

setupTestConfig('prompts-fail-open');

const { loadPersonas, loadScriptReview, savePersonas, saveScriptReview } = await import('../src/scheduler/promptsUtil.js');
const { registerStudioShowsApi } = await import('../src/server/studioShowsApi.js');
const { config } = await import('../src/config/index.js');

function briefDir() {
  return config.paths.showDescriptionsDir;
}

async function showsApp() {
  const fastify = Fastify({ logger: false });
  registerStudioShowsApi(fastify);
  return fastify;
}

describe('promptsUtil (dataDir/prompts.json fail-open)', () => {
  test('fresh deploy: no prompts.json -> honest empty, never a throw', () => {
    fs.rmSync(config.paths.promptsFile, { force: true });
    assert.deepEqual(loadPersonas(), {});
    assert.deepEqual(loadScriptReview(), { enabled: true, systemPrompt: null });
  });

  test('torn prompts.json reads as empty too (atomic writes make this rare, not impossible)', () => {
    fs.writeFileSync(config.paths.promptsFile, '{"personas": {"markec":'); // torn
    assert.deepEqual(loadPersonas(), {});
  });

  test('valid file behavior unchanged; a save from empty recreates the file', async () => {
    fs.rmSync(config.paths.promptsFile, { force: true });
    await savePersonas({ markec: { voiceFile: 'markec.wav', systemPrompt: 'Ti si Markec.' } });
    assert.deepEqual(loadPersonas(), { markec: { voiceFile: 'markec.wav', systemPrompt: 'Ti si Markec.' } });

    await saveScriptReview('Poglej scenarij.');
    const review = loadScriptReview();
    assert.equal(review.systemPrompt, 'Poglej scenarij.');
    // the earlier personas survive the scriptReview save (one file, two blocks)
    assert.equal(loadPersonas().markec.voiceFile, 'markec.wav');
  });
});

describe('studioShowsApi GET /api/shows (show-descriptions/ fail-open)', () => {
  test('fresh deploy: no show-descriptions dir -> 200 with an empty list', async () => {
    fs.rmSync(briefDir(), { recursive: true, force: true });
    const fastify = await showsApp();
    const res = await fastify.inject({ method: 'GET', url: '/api/shows' });
    assert.equal(res.statusCode, 200, 'no raw 500 with an absolute-path leak');
    assert.deepEqual(res.json(), { shows: [] });
    await fastify.close();
  });

  test('one unreadable brief is skipped; valid briefs still listed identically', async () => {
    fs.rmSync(briefDir(), { recursive: true, force: true });
    fs.mkdirSync(briefDir(), { recursive: true });
    fs.writeFileSync(
      path.join(briefDir(), 'rock-vecer.md'),
      '# Rock Večer\n**Personas:** markec, vesna\n**Segments:** quiz, weather\n\nProsti tekst.\n'
    );
    // A DIRECTORY named like a brief: readFileSync throws EISDIR for it --
    // deterministic on every uid, unlike a chmod trick (root ignores modes).
    fs.mkdirSync(path.join(briefDir(), 'broken.md'));
    const fastify = await showsApp();
    const res = await fastify.inject({ method: 'GET', url: '/api/shows' });
    assert.equal(res.statusCode, 200);
    const { shows } = res.json();
    assert.equal(shows.length, 1, 'the unreadable brief costs exactly itself');
    assert.equal(shows[0].id, 'rock-vecer');
    assert.equal(shows[0].title, 'Rock Večer');
    assert.deepEqual(shows[0].personas, ['markec', 'vesna']);
    assert.deepEqual(shows[0].segments, ['quiz', 'weather']);
    await fastify.close();
  });
});
