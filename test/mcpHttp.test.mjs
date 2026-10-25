// Remote MCP transport over HTTP (src/server/studioMcpApi.js): mounted
// through the FULL studio plugin (registerStudioRoutes + { prefix: '/studio' }),
// the production shape from src/server/index.js -- the 17-b lesson: a bare
// mount of the registrar module hides prefix bugs. These tests therefore pin
// the real URL /studio/api/mcp, the real studio Basic realm, the inherited
// JSON-content-type CSRF rule, AND the module's own contracts: the pure
// mcpRemoteEnabled gate, the one-instance parity with the stdio assembly
// (same serverInfo), the 202/400/200 status mapping of the JSON-RPC core,
// the Origin defense, and the stateless 405s. In-process inject() only --
// zero real listen, zero network (now_playing/poll_create touch no socket).
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import Fastify from 'fastify';

import { setupTestConfig } from './fixtures.mjs';

setupTestConfig('mcp-http', {
  web: { port: 3997, publicPaths: [] },
  studio: { users: [{ username: 'studio', password: 'mcp-geslo' }] },
  mcp: { remote: { enabled: true } },
});

const { registerStudioRoutes } = await import('../src/server/studioAuth.js');
const { mcpRemoteEnabled } = await import('../src/server/studioMcpApi.js');
const { config } = await import('../src/config/index.js');

const MCP_URL = '/studio/api/mcp';
const AUTH = { authorization: `Basic ${Buffer.from('studio:mcp-geslo').toString('base64')}` };

async function app() {
  const fastify = Fastify({ logger: false });
  await fastify.register(registerStudioRoutes, { prefix: '/studio' });
  await fastify.ready();
  return fastify;
}

const rpc = (obj) => JSON.stringify(obj);

function post(fastify, payload, headers = {}) {
  return fastify.inject({
    method: 'POST',
    url: MCP_URL,
    headers: { ...AUTH, 'content-type': 'application/json', ...headers },
    payload,
  });
}

describe('mcpRemoteEnabled (pure helper)', () => {
  test('remote is opt-in ONLY: every missing/false shape refuses', () => {
    assert.equal(mcpRemoteEnabled(undefined), false);
    assert.equal(mcpRemoteEnabled({}), false);
    assert.equal(mcpRemoteEnabled({ mcp: undefined }), false);
    assert.equal(mcpRemoteEnabled({ mcp: {} }), false);
    assert.equal(mcpRemoteEnabled({ mcp: { enabled: true } }), false);
    assert.equal(mcpRemoteEnabled({ mcp: { remote: {} } }), false);
    assert.equal(mcpRemoteEnabled({ mcp: { remote: { enabled: false } } }), false);
  });

  test('explicit remote opt-in passes; mcp.enabled:false vetoes it', () => {
    assert.equal(mcpRemoteEnabled({ mcp: { remote: { enabled: true } } }), true);
    assert.equal(mcpRemoteEnabled({ mcp: { enabled: true, remote: { enabled: true } } }), true);
    assert.equal(mcpRemoteEnabled({ mcp: { enabled: false, remote: { enabled: true } } }), false);
  });
});

describe('POST /studio/api/mcp (remote transport on)', () => {
  test('initialize -> 200, protocol echo, pinned serverInfo (same values as stdio), tools capability', async () => {
    const fastify = await app();
    const res = await post(fastify, rpc({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } }));
    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.equal(body.jsonrpc, '2.0');
    assert.equal(body.id, 1);
    assert.equal(body.result.protocolVersion, '2025-06-18');
    // The same identity the stdio entry pins (server.js:63) -- one station,
    // one MCP name, whichever transport the client speaks.
    assert.equal(body.result.serverInfo.name, 'radioclyde-mcp');
    assert.equal(body.result.serverInfo.version, '0.1.0');
    assert.deepEqual(body.result.capabilities, { tools: {} });
    await fastify.close();
  });

  test('notifications/initialized -> 202, empty body (the core never answers notifications)', async () => {
    const fastify = await app();
    const res = await post(fastify, rpc({ jsonrpc: '2.0', method: 'notifications/initialized' }));
    assert.equal(res.statusCode, 202);
    assert.ok(!res.payload, 'no response body for a notification');
    await fastify.close();
  });

  test('tools/list -> all 29 tools, now_playing + poll_create among them', async () => {
    const fastify = await app();
    const res = await post(fastify, rpc({ jsonrpc: '2.0', id: 2, method: 'tools/list' }));
    assert.equal(res.statusCode, 200);
    const body = res.json();
    const names = body.result.tools.map((t) => t.name);
    assert.equal(names.length, 29);
    assert.ok(names.includes('now_playing'));
    assert.ok(names.includes('poll_create'));
    await fastify.close();
  });

  test('tools/call now_playing -> 200 with the honest empty-state shape (empty test dataDir)', async () => {
    const fastify = await app();
    const res = await post(fastify, rpc({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'now_playing' } }));
    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.equal(body.id, 3);
    assert.notEqual(body.result.isError, true);
    // The tool returns composeNowPlaying()'s fresh-dataDir shape verbatim as
    // pretty JSON text (nowPlaying.js:53-54: no state file -> nothing loaded).
    const value = JSON.parse(body.result.content[0].text);
    assert.equal(value.station.name, 'Test Station');
    assert.deepEqual(value.station.streams, [
      { url: 'http://localhost:3997/stream', format: 'mp3', bitrate: 128 },
    ]);
    assert.equal(value.show, null);
    assert.equal(value.track, null);
    assert.equal(value.dj, null);
    assert.equal(value.scheduledStart, null);
    assert.equal(value.estimatedEndAt, null);
    await fastify.close();
  });

  test('tools/call poll_create -> 200, poll persisted in the store, new audit line in logs/mcp.log', async () => {
    const fastify = await app();
    const logFile = path.join(config.paths.logsDir, 'mcp.log');
    const linesBefore = fs.existsSync(logFile)
      ? fs.readFileSync(logFile, 'utf8').split('\n').filter(Boolean).length
      : 0;

    const res = await post(
      fastify,
      rpc({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'poll_create', arguments: { question: 'Kateri format?', options: ['mp3', 'flac'] } } })
    );
    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.notEqual(body.result.isError, true);
    const value = JSON.parse(body.result.content[0].text);
    assert.equal(value.ok, true);
    assert.equal(value.poll.question, 'Kateri format?');
    assert.deepEqual(value.poll.options, ['mp3', 'flac']);

    // The write really landed in the test dataDir store (pollsStore writes
    // config.paths.pollsFile atomically).
    const store = JSON.parse(fs.readFileSync(config.paths.pollsFile, 'utf8'));
    assert.equal(store.active.question, 'Kateri format?');
    assert.deepEqual(store.active.options, ['mp3', 'flac']);

    // And at least one new audit line landed in the mcp log: the tool's own
    // "poll_create: ..." line plus this module's one-line-per-POST line.
    const linesAfter = fs.readFileSync(logFile, 'utf8').split('\n').filter(Boolean);
    assert.ok(linesAfter.length > linesBefore, 'a new audit line landed in logs/mcp.log');
    assert.ok(linesAfter.some((l) => l.includes('poll_create:')), 'the tool\'s own audit line is there');
    await fastify.close();
  });

  test('raw broken JSON -> 400 with the core\'s -32700 (the scoped string parser feeds protocol.js, not Fastify\'s parser)', async () => {
    const fastify = await app();
    const res = await post(fastify, '{"jsonrpc":"2.0","id":1,"method":');
    assert.equal(res.statusCode, 400);
    const body = res.json();
    assert.equal(body.jsonrpc, '2.0');
    assert.equal(body.error.code, -32700);
    await fastify.close();
  });

  test('JSON array (batch) -> 400 with -32600', async () => {
    const fastify = await app();
    const res = await post(fastify, '[{"jsonrpc":"2.0","id":1,"method":"ping"}]');
    assert.equal(res.statusCode, 400);
    assert.equal(res.json().error.code, -32600);
    await fastify.close();
  });

  test('JSON-RPC-level errors travel as 200: unknown method -> -32601 in a 200 body', async () => {
    const fastify = await app();
    const res = await post(fastify, rpc({ jsonrpc: '2.0', id: 5, method: 'no/such/method' }));
    assert.equal(res.statusCode, 200);
    assert.equal(res.json().error.code, -32601);
    await fastify.close();
  });

  test('no Authorization -> 401 + studio realm; wrong password -> 401', async () => {
    const fastify = await app();
    const no = await fastify.inject({
      method: 'POST',
      url: MCP_URL,
      headers: { 'content-type': 'application/json' },
      payload: rpc({ jsonrpc: '2.0', id: 1, method: 'ping' }),
    });
    assert.equal(no.statusCode, 401);
    assert.match(no.headers['www-authenticate'], /Basic realm="radioclyde-studio"/);

    const wrong = await fastify.inject({
      method: 'POST',
      url: MCP_URL,
      headers: {
        authorization: `Basic ${Buffer.from('studio:napacno-geslo').toString('base64')}`,
        'content-type': 'application/json',
      },
      payload: rpc({ jsonrpc: '2.0', id: 1, method: 'ping' }),
    });
    assert.equal(wrong.statusCode, 401);
    await fastify.close();
  });

  test('GET -> 405 (no SSE stream); DELETE -> 405 (no sessions) -- both with honest {error} bodies', async () => {
    const fastify = await app();
    const get = await fastify.inject({ method: 'GET', url: MCP_URL, headers: AUTH });
    assert.equal(get.statusCode, 405);
    assert.ok(get.json().error);

    // DELETE is a write method for the inherited CSRF rule, so it needs the
    // application/json content type to even reach the handler (the same
    // dance as the archives DELETE tests).
    const del = await fastify.inject({
      method: 'DELETE',
      url: MCP_URL,
      headers: { ...AUTH, 'content-type': 'application/json' },
      payload: '{}',
    });
    assert.equal(del.statusCode, 405);
    assert.ok(del.json().error);
    await fastify.close();
  });

  test('foreign Origin -> 403; same-host Origin -> 200; no-Origin requests pass (covered by every other test here)', async () => {
    const fastify = await app();
    const foreign = await post(fastify, rpc({ jsonrpc: '2.0', id: 6, method: 'ping' }), { origin: 'https://evil.example' });
    assert.equal(foreign.statusCode, 403);
    assert.ok(foreign.json().error);

    // Same host, port included on both sides (inject's default Host is
    // localhost:80, so both headers are set explicitly for determinism).
    const same = await post(
      fastify,
      rpc({ jsonrpc: '2.0', id: 7, method: 'ping' }),
      { host: 'radio-markec.test:8443', origin: 'https://radio-markec.test:8443' }
    );
    assert.equal(same.statusCode, 200);
    assert.equal(same.json().id, 7);

    // Default-port spelling: a browser omits :443 in Origin (scheme default),
    // a fronting proxy may still spell it out in Host -- that is same-host.
    const defaulted = await post(
      fastify,
      rpc({ jsonrpc: '2.0', id: 8, method: 'ping' }),
      { host: 'radio-markec.test:443', origin: 'https://radio-markec.test' }
    );
    assert.equal(defaulted.statusCode, 200);
    await fastify.close();
  });

  test('MCP-Protocol-Version header is ignored (the core echoes initialize\'s version) -> 200', async () => {
    const fastify = await app();
    const res = await post(
      fastify,
      rpc({ jsonrpc: '2.0', id: 9, method: 'initialize', params: { protocolVersion: '2025-06-18' } }),
      { 'mcp-protocol-version': '1999-01-01' }
    );
    assert.equal(res.statusCode, 200);
    assert.equal(res.json().result.protocolVersion, '2025-06-18');
    await fastify.close();
  });

  test('content-type text/plain -> 415 (the studio plugin\'s inherited CSRF preHandler pin)', async () => {
    const fastify = await app();
    const res = await post(fastify, rpc({ jsonrpc: '2.0', id: 1, method: 'ping' }), { 'content-type': 'text/plain' });
    assert.equal(res.statusCode, 415);
    await fastify.close();
  });

  test('string id "abc-123" is echoed verbatim', async () => {
    const fastify = await app();
    const res = await post(fastify, rpc({ jsonrpc: '2.0', id: 'abc-123', method: 'ping' }));
    assert.equal(res.statusCode, 200);
    assert.equal(res.json().id, 'abc-123');
    await fastify.close();
  });

  test("content-type 'application/json; charset=utf-8' -> 200 (parameterized type reaches the scoped string parser)", async () => {
    const fastify = await app();
    const res = await post(
      fastify,
      rpc({ jsonrpc: '2.0', id: 10, method: 'ping' }),
      { 'content-type': 'application/json; charset=utf-8' }
    );
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.json().result, {});

    // Which path ran? Proven with a syntactically BROKEN body: the custom
    // string parser hands the raw text to the core -> -32700 from protocol.js
    // (Fastify's own default JSON parser would answer FST_ERR_CTP_INVALID_
    // JSON_BODY instead). Fastify resolves a parameterized header to the
    // parser registered under the media type (content-type-parser.js
    // getParser -> customParsers.get(contentType.mediaType)), so the STRING
    // parser path is the one that runs -- the belt-and-suspenders object
    // branch in the handler stays as defense, unexercised here.
    const broken = await post(fastify, '{not json', { 'content-type': 'application/json; charset=utf-8' });
    assert.equal(broken.statusCode, 400);
    assert.equal(broken.json().error.code, -32700);
    await fastify.close();
  });
});
