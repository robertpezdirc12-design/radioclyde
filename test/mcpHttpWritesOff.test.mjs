// Remote MCP with the write kill-switch on: mcp.allowWriteTools: false must
// hold over the HTTP transport exactly as it does over stdio -- tools/list
// hides the 13 write tools (30 - 13 = 17 listed) and a direct tools/call of a
// write tool is refused with the core's isError naming the kill-switch
// (protocol.js:91-102). The refusal is a 200 with a JSON-RPC result (an
// honest business answer, not a protocol/HTTP error). Full-plugin mount,
// production shape (the 17-b lesson).
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';

import { setupTestConfig } from './fixtures.mjs';

setupTestConfig('mcp-writes-off', {
  studio: { users: [{ username: 'studio', password: 'mcp-geslo' }] },
  mcp: { allowWriteTools: false, remote: { enabled: true } },
});

const { registerStudioRoutes } = await import('../src/server/studioAuth.js');

const MCP_URL = '/studio/api/mcp';
const AUTH = { authorization: `Basic ${Buffer.from('studio:mcp-geslo').toString('base64')}` };

async function app() {
  const fastify = Fastify({ logger: false });
  await fastify.register(registerStudioRoutes, { prefix: '/studio' });
  await fastify.ready();
  return fastify;
}

function post(fastify, payload) {
  return fastify.inject({
    method: 'POST',
    url: MCP_URL,
    headers: { ...AUTH, 'content-type': 'application/json' },
    payload,
  });
}

describe('remote MCP with allowWriteTools: false', () => {
  test('tools/list -> the 17 read tools only (30 - 13 write tools hidden)', async () => {
    const fastify = await app();
    const res = await post(fastify, JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }));
    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.equal(body.result.tools.length, 17);
    assert.ok(
      body.result.tools.every((t) => !['poll_create', 'skip_track', 'update_station_meta', 'schedule_set_date'].includes(t.name))
    );
    await fastify.close();
  });

  test('tools/call poll_create -> 200 with isError naming the kill-switch (meaning-pinned, not byte-exact)', async () => {
    const fastify = await app();
    const res = await post(
      fastify,
      JSON.stringify({
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: { name: 'poll_create', arguments: { question: 'Kateri format?', options: ['mp3', 'flac'] } },
      })
    );
    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.equal(body.id, 2);
    assert.equal(body.result.isError, true);
    // protocol.js's refusal text names the config lever, its false value and
    // its purpose -- pin the meaning, not the exact wording.
    const text = body.result.content[0].text;
    assert.match(text, /mcp\.allowWriteTools/);
    assert.match(text, /false/);
    assert.match(text, /stikalo/);
    await fastify.close();
  });
});
