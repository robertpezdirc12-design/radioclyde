// Remote-off pin for the MCP HTTP transport: the mcp block is present (and
// enabled-by-default) but WITHOUT the remote opt-in -- exactly the shipped
// default state of every config that predates mcp.remote. The route must be
// ABSENT (404), the streamProxy.js discipline ("a disabled mount must 404,
// route absent" -- not a 503 "disabled" route that still announces the
// surface). Full-plugin mount (registerStudioRoutes + prefix '/studio'), the
// production shape -- the 17-b lesson.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';

import { setupTestConfig } from './fixtures.mjs';

// mcp: {} -- enabled by the missing-block-means-enabled precedent, remote
// NOT opted in: the strongest pin of the default (even an otherwise-on MCP
// station does not expose the HTTP surface without an explicit opt-in).
setupTestConfig('mcp-remote-off', {
  studio: { users: [{ username: 'studio', password: 'mcp-geslo' }] },
  mcp: {},
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

describe('remote MCP off (no mcp.remote opt-in)', () => {
  test('POST /studio/api/mcp with a valid initialize + studio creds -> 404, route absent', async () => {
    const fastify = await app();
    const res = await fastify.inject({
      method: 'POST',
      url: MCP_URL,
      headers: { ...AUTH, 'content-type': 'application/json' },
      payload: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } }),
    });
    assert.equal(res.statusCode, 404);
    await fastify.close();
  });

  test('GET is absent too (404), while a sibling studio route still answers -- only the MCP mount is gone', async () => {
    const fastify = await app();
    const get = await fastify.inject({ method: 'GET', url: MCP_URL, headers: AUTH });
    assert.equal(get.statusCode, 404);

    // The rest of the studio plugin mounted fine -- the 404 is the gate, not
    // a broken registration (the archives index is an honest empty here).
    const sibling = await fastify.inject({ method: 'GET', url: '/studio/api/archives', headers: AUTH });
    assert.equal(sibling.statusCode, 200);
    assert.deepEqual(sibling.json(), { archives: [], truncated: false });
    await fastify.close();
  });
});
