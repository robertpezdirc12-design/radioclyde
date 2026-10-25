// Studio archive browser (src/server/studioArchivesApi.js): registered through
// the FULL studio plugin (registerStudioRoutes), so these tests also pin the
// real Basic-Auth realm and the JSON-content-type CSRF rule around the new
// routes. The disk under <dataDir>/archive/ is seeded directly -- Liquidsoap's
// output.file layout (YYYY-MM-DD/HH-00.mp3) is the contract under test, plus
// the honest index cap, the size-pinned download, and safe-on-air deletion.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import Fastify from 'fastify';

import { setupTestConfig } from './fixtures.mjs';

setupTestConfig('studio-archives', {
  studio: { users: [{ username: 'studio', password: 'sekret' }] },
});

const { registerStudioRoutes } = await import('../src/server/studioAuth.js');
const { config } = await import('../src/config/index.js');

const ARCHIVES_DIR = path.join(config.dataDir, 'archive');
const AUTH = { authorization: `Basic ${Buffer.from('studio:sekret').toString('base64')}` };

async function app() {
  const fastify = Fastify({ logger: false });
  await fastify.register(registerStudioRoutes, { prefix: '/studio' });
  await fastify.ready();
  return fastify;
}

function writeHour(date, hour, size = 16) {
  const file = path.join(ARCHIVES_DIR, date, `${hour}-00.mp3`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const buf = Buffer.alloc(size);
  for (let i = 0; i < size; i++) buf[i] = (i * 7 + Number(hour)) % 256;
  fs.writeFileSync(file, buf);
  return file;
}

function dayKey(offsetDays) {
  return new Date(Date.UTC(2030, 0, 1 + offsetDays)).toISOString().slice(0, 10);
}

describe('studio realm around the archive routes', () => {
  test('no credentials -> the studio Basic Auth realm answers 401', async () => {
    const fastify = await app();
    const res = await fastify.inject({ method: 'GET', url: '/studio/api/archives' });
    assert.equal(res.statusCode, 401);
    assert.match(res.headers['www-authenticate'], /Basic realm="radioclyde-studio"/);
    await fastify.close();
  });

  test('DELETE without an application/json content type -> CSRF rule 415', async () => {
    const fastify = await app();
    const res = await fastify.inject({
      method: 'DELETE',
      url: '/studio/api/archives/2030-01-02',
      headers: { ...AUTH, 'content-type': 'text/plain' },
    });
    assert.equal(res.statusCode, 415);
    await fastify.close();
  });
});

describe('GET /studio/api/archives (index)', () => {
  test('missing archive dir -> an empty index, not an error', async () => {
    fs.rmSync(ARCHIVES_DIR, { recursive: true, force: true });
    const fastify = await app();
    const res = await fastify.inject({ method: 'GET', url: '/studio/api/archives', headers: AUTH });
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.json(), { archives: [], truncated: false });
    await fastify.close();
  });

  test('newest-first, only HH-00.mp3 hour files, junk left out, bytes reported', async () => {
    fs.rmSync(ARCHIVES_DIR, { recursive: true, force: true });
    writeHour('2030-01-02', '09', 32);
    writeHour('2030-01-02', '23', 48);
    writeHour('2030-01-01', '05', 16);
    // junk neighbours: wrong shape / not a date dir / stray files in a day dir
    fs.mkdirSync(path.join(ARCHIVES_DIR, 'not-a-date'), { recursive: true });
    fs.writeFileSync(path.join(ARCHIVES_DIR, 'not-a-date', '10-00.mp3'), Buffer.alloc(8));
    fs.writeFileSync(path.join(ARCHIVES_DIR, '2030-01-02', '09-30.mp3'), Buffer.alloc(8));
    fs.writeFileSync(path.join(ARCHIVES_DIR, '2030-01-02', 'notes.txt'), Buffer.alloc(8));
    fs.writeFileSync(path.join(ARCHIVES_DIR, 'lost.mp3'), Buffer.alloc(8));

    const fastify = await app();
    const res = await fastify.inject({ method: 'GET', url: '/studio/api/archives', headers: AUTH });
    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.equal(body.truncated, false);
    assert.deepEqual(
      body.archives.map((a) => `${a.date} ${a.hour}`),
      ['2030-01-02 23', '2030-01-02 09', '2030-01-01 05']
    );
    assert.deepEqual(
      body.archives.map((a) => a.file),
      ['23-00.mp3', '09-00.mp3', '05-00.mp3']
    );
    assert.deepEqual(
      body.archives.map((a) => a.bytes),
      [48, 32, 16]
    );
    await fastify.close();
  });

  test('cap 500 with an honest truncated flag (newest 500 kept)', async () => {
    fs.rmSync(ARCHIVES_DIR, { recursive: true, force: true });
    // 22 days x 24 hours = 528 files -> 28 over the cap.
    for (let d = 0; d < 22; d++) {
      for (let h = 0; h < 24; h++) writeHour(dayKey(d), String(h).padStart(2, '0'), 4);
    }
    const fastify = await app();
    const res = await fastify.inject({ method: 'GET', url: '/studio/api/archives', headers: AUTH });
    const body = res.json();
    assert.equal(body.archives.length, 500);
    assert.equal(body.truncated, true);
    // newest-first: the first listed hour is the newest day's hour 23.
    assert.equal(body.archives[0].date, dayKey(21));
    assert.equal(body.archives[0].hour, '23');
    await fastify.close();
  });
});

describe('GET /studio/api/archives/file/:date/:hour (download)', () => {
  test('bytes verbatim, audio/mpeg, attachment disposition, pinned length', async () => {
    fs.rmSync(ARCHIVES_DIR, { recursive: true, force: true });
    const file = writeHour('2030-01-02', '14', 64);
    const fastify = await app();
    const res = await fastify.inject({ method: 'GET', url: '/studio/api/archives/file/2030-01-02/14', headers: AUTH });
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.rawPayload, fs.readFileSync(file));
    assert.match(res.headers['content-type'], /^audio\/mpeg/);
    assert.equal(res.headers['content-length'], '64');
    assert.match(res.headers['content-disposition'], /^attachment; filename="2030-01-02-14-00\.mp3"$/);
    await fastify.close();
  });

  test('strict params and traversal attempts -> 400; unknown hour -> 404', async () => {
    fs.rmSync(ARCHIVES_DIR, { recursive: true, force: true });
    writeHour('2030-01-02', '14', 8);
    const fastify = await app();
    for (const url of [
      '/studio/api/archives/file/2030-1-2/14', // date not zero-padded
      '/studio/api/archives/file/2030-01-02/1x', // hour not HH
      '/studio/api/archives/file/2030-01-02/999',
      '/studio/api/archives/file/..%2F..%2Fetc/14', // URL-encoded traversal
      '/studio/api/archives/file/2030-01-02/..%2F..%2Fconfig.json'.replace('/14', ''),
    ]) {
      const res = await fastify.inject({ method: 'GET', url, headers: AUTH });
      assert.equal(res.statusCode, 400, `${url} must be rejected as invalid input`);
    }
    const missing = await fastify.inject({ method: 'GET', url: '/studio/api/archives/file/2030-01-02/15', headers: AUTH });
    assert.equal(missing.statusCode, 404); // valid shape, nothing on disk
    await fastify.close();
  });
});

describe('DELETE /studio/api/archives/:date', () => {
  test('drops a whole day, 404 when absent, invalid date -> 400', async () => {
    fs.rmSync(ARCHIVES_DIR, { recursive: true, force: true });
    writeHour('2030-01-02', '09', 8);
    writeHour('2030-01-01', '10', 8);
    const fastify = await app();

    // payload '{}' because the CSRF rule requires an application/json
    // content-type and Fastify rejects an EMPTY json body with its own 400
    // before any route runs.
    const del = (url) =>
      fastify.inject({
        method: 'DELETE',
        url,
        headers: { ...AUTH, 'content-type': 'application/json' },
        payload: '{}',
      });

    const bad = await del('/studio/api/archives/not-a-date');
    assert.equal(bad.statusCode, 400);

    const gone = await del('/studio/api/archives/2030-05-05');
    assert.equal(gone.statusCode, 404);

    const ok = await del('/studio/api/archives/2030-01-02');
    assert.equal(ok.statusCode, 200);
    assert.deepEqual(ok.json(), { ok: true, removed: '2030-01-02' });
    assert.ok(!fs.existsSync(path.join(ARCHIVES_DIR, '2030-01-02')));
    assert.ok(fs.existsSync(path.join(ARCHIVES_DIR, '2030-01-01')), 'other days untouched');
    await fastify.close();
  });
});
