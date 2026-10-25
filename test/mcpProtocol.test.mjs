// Protocol-core tests for the MCP stdio server (src/mcp/protocol.js).
// Purely in-process: a stub tool set, createMcpServer(), and handleLine()
// strings -- no config.json, no spawn, no network. The ONLY file that pins
// the JSON-RPC 2.0 surface (id correlation, notification rules, the five
// error codes, tools/list filtering, the isError-vs-error-code split).
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { createMcpServer, DEFAULT_PROTOCOL_VERSION, ToolFailure } from '../src/mcp/protocol.js';

// Minimal honest stub set: one read tool, one write tool, one tool that
// fails at the business level, one that throws a real bug.
const STUB_TOOLS = [
  {
    name: 'echo',
    description: 'echoes its argument back',
    inputSchema: { type: 'object', properties: { value: {} } },
    write: false,
    handler: async (args) => ({ echoed: args.value ?? null }),
  },
  {
    name: 'flip',
    description: 'flips a switch',
    inputSchema: { type: 'object', properties: {} },
    write: true,
    handler: async () => ({ flipped: true }),
  },
  {
    name: 'refuse',
    description: 'always refuses honestly',
    inputSchema: { type: 'object', properties: {} },
    write: false,
    handler: async () => {
      throw new ToolFailure('Ta zahtevek ne obstaja.');
    },
  },
  {
    name: 'buggy',
    description: 'throws a real error',
    inputSchema: { type: 'object', properties: {} },
    write: false,
    handler: async () => {
      throw new TypeError('boom');
    },
  },
];

function server(overrides = {}) {
  return createMcpServer({ tools: STUB_TOOLS, ...overrides });
}

function parse(line) {
  return JSON.parse(line);
}

function request(id, method, params) {
  return JSON.stringify({ jsonrpc: '2.0', id, method, ...(params !== undefined ? { params } : {}) });
}

describe('initialize', () => {
  test('echoes the client protocolVersion when provided; capabilities + serverInfo ride along', async () => {
    const s = server();
    const res = parse(await s.handleLine(request(1, 'initialize', { protocolVersion: '2024-11-05' })));
    assert.equal(res.jsonrpc, '2.0');
    assert.equal(res.id, 1);
    assert.equal(res.result.protocolVersion, '2024-11-05');
    assert.deepEqual(res.result.capabilities, { tools: {} });
    assert.equal(res.result.serverInfo.name, 'radioclyde-mcp');
    assert.equal(res.result.serverInfo.version, '0.1.0');
  });

  test('no protocolVersion in params -> the pinned default, not undefined', async () => {
    const res = parse(await server().handleLine(request(2, 'initialize', {})));
    assert.equal(res.result.protocolVersion, DEFAULT_PROTOCOL_VERSION);
  });

  test('custom serverInfo is echoed verbatim (the server sets its own identity)', async () => {
    const res = parse(
      await server({ serverInfo: { name: 'x', version: '9.9.9' } }).handleLine(request(1, 'initialize'))
    );
    assert.deepEqual(res.result.serverInfo, { name: 'x', version: '9.9.9' });
  });
});

describe('notifications', () => {
  test('notifications/initialized never answers', async () => {
    assert.equal(await server().handleLine(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })), null);
  });

  test('an unknown notification is ignored silently (no -32601 for id-less messages)', async () => {
    assert.equal(await server().handleLine(JSON.stringify({ jsonrpc: '2.0', method: 'something/else' })), null);
  });
});

describe('tools/list', () => {
  test('lists every tool with name/description/inputSchema', async () => {
    const res = parse(await server().handleLine(request('list-1', 'tools/list')));
    assert.equal(res.id, 'list-1');
    assert.equal(res.result.tools.length, STUB_TOOLS.length);
    for (const entry of res.result.tools) {
      assert.equal(typeof entry.name, 'string');
      assert.equal(typeof entry.description, 'string');
      assert.equal(typeof entry.inputSchema, 'object');
    }
    assert.ok(res.result.tools.some((t) => t.name === 'flip'));
  });

  test('allowWriteTools:false omits write tools entirely', async () => {
    const res = parse(await server({ allowWriteTools: false }).handleLine(request(1, 'tools/list')));
    assert.deepEqual(res.result.tools.map((t) => t.name), ['echo', 'refuse', 'buggy']);
  });
});

describe('tools/call', () => {
  test('success: the handler value arrives as pretty-JSON text content', async () => {
    const res = parse(await server().handleLine(request(7, 'tools/call', { name: 'echo', arguments: { value: 'markec' } })));
    assert.equal(res.id, 7);
    assert.deepEqual(res.result.content, [{ type: 'text', text: JSON.stringify({ echoed: 'markec' }, null, 2) }]);
    assert.notEqual(res.result.isError, true);
  });

  test('missing arguments key is tolerated (handler sees {})', async () => {
    const res = parse(await server().handleLine(request(1, 'tools/call', { name: 'echo' })));
    assert.deepEqual(res.result.content, [{ type: 'text', text: JSON.stringify({ echoed: null }, null, 2) }]);
  });

  test('tool-level business failure -> isError:true with the honest message text', async () => {
    const res = parse(await server().handleLine(request(3, 'tools/call', { name: 'refuse' })));
    assert.equal(res.result.isError, true);
    assert.equal(res.result.content[0].type, 'text');
    assert.equal(res.result.content[0].text, 'Ta zahtevek ne obstaja.');
  });

  test('a handler that throws a REAL error -> -32603 internal, message surfaced, no crash', async () => {
    const res = parse(await server().handleLine(request(4, 'tools/call', { name: 'buggy' })));
    assert.equal(res.error.code, -32603);
    assert.match(res.error.message, /boom/);
    assert.equal(res.id, 4);
  });

  test('unknown tool name -> -32602 invalid params', async () => {
    const res = parse(await server().handleLine(request(5, 'tools/call', { name: 'nope' })));
    assert.equal(res.error.code, -32602);
    assert.match(res.error.message, /nope/);
  });

  test('params that is not an object -> -32602', async () => {
    const res = parse(await server().handleLine(request(1, 'tools/call', 'echo')));
    assert.equal(res.error.code, -32602);
  });

  test('write tool with allowWriteTools:false -> isError naming the kill-switch', async () => {
    const res = parse(await server({ allowWriteTools: false }).handleLine(request(6, 'tools/call', { name: 'flip' })));
    assert.equal(res.result.isError, true);
    assert.match(res.result.content[0].text, /allowWriteTools/);
  });

  test('configOk:false -> every call answers isError with the config message (catalog still lists)', async () => {
    const s = server({ configOk: false, configError: 'config.json not found at /x/config.json.' });
    const res = parse(await s.handleLine(request(1, 'tools/call', { name: 'echo' })));
    assert.equal(res.result.isError, true);
    assert.match(res.result.content[0].text, /config\.json ni uporaben: config\.json not found/);
    // and the static surfaces keep working:
    const init = parse(await s.handleLine(request(2, 'initialize')));
    assert.equal(init.result.serverInfo.name, 'radioclyde-mcp');
    const list = parse(await s.handleLine(request(3, 'tools/list')));
    assert.equal(list.result.tools.length, STUB_TOOLS.length);
  });
});

describe('ping', () => {
  test('answers an empty result object', async () => {
    const res = parse(await server().handleLine(request('p', 'ping')));
    assert.deepEqual(res.result, {});
    assert.equal(res.id, 'p');
  });
});

describe('JSON-RPC error codes', () => {
  test('-32700: garbage line -> parse error with id null', async () => {
    const res = parse(await server().handleLine('{not json'));
    assert.equal(res.error.code, -32700);
    assert.equal(res.id, null);
  });

  test('-32600: a JSON array (batch) line is refused', async () => {
    const res = parse(await server().handleLine('[{"jsonrpc":"2.0","id":1,"method":"ping"}]'));
    assert.equal(res.error.code, -32600);
    assert.match(res.error.message, /batch/);
  });

  test('-32600: non-object JSON (string/number/null)', async () => {
    assert.equal(parse(await server().handleLine('"hello"')).error.code, -32600);
    assert.equal(parse(await server().handleLine('42')).error.code, -32600);
    assert.equal(parse(await server().handleLine('null')).error.code, -32600);
  });

  test('-32600: missing jsonrpc or method', async () => {
    assert.equal(parse(await server().handleLine('{"id":1,"method":"ping"}')).error.code, -32600);
    assert.equal(parse(await server().handleLine('{"jsonrpc":"2.0","id":1}')).error.code, -32600);
  });

  test('-32601: unknown method on a REQUEST (with id) is answered', async () => {
    const res = parse(await server().handleLine(request(42, 'resources/list')));
    assert.equal(res.error.code, -32601);
    assert.equal(res.id, 42);
  });

  test('-32602 and -32603 are covered by the tools/call cases above; blank line is silence', async () => {
    assert.equal(await server().handleLine('   '), null);
    assert.equal(await server().handleLine(''), null);
  });
});

describe('id correlation', () => {
  test('string / number / null ids are echoed verbatim', async () => {
    assert.equal(parse(await server().handleLine(request('abc', 'ping'))).id, 'abc');
    assert.equal(parse(await server().handleLine(request(0, 'ping'))).id, 0);
    assert.equal(parse(await server().handleLine(request(null, 'ping'))).id, null);
  });

  test('a message with NO id key is never answered -- even for a method that would reply', async () => {
    const line = JSON.stringify({ jsonrpc: '2.0', method: 'ping' });
    assert.equal(await server().handleLine(line), null);
  });
});

describe('sequential processing', () => {
  test('the second tools/call is dispatched only after the first resolves (deferred handler)', async () => {
    const order = [];
    let release;
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    const tools = [
      {
        name: 'slow',
        description: 'waits for the gate',
        inputSchema: { type: 'object', properties: {} },
        write: false,
        handler: async (args) => {
          if (args.wait) await gate;
          order.push(args.wait ? 'slow-done' : 'fast-done');
          return { ok: true };
        },
      },
    ];
    const s = createMcpServer({ tools });

    // Model the server's read loop exactly (server.js): each line is awaited
    // before the next is read -- that await is what makes dispatch sequential.
    const outputs = [];
    const loop = (async () => {
      for (const line of [
        request(1, 'tools/call', { name: 'slow', arguments: { wait: true } }),
        request(2, 'tools/call', { name: 'slow', arguments: { wait: false } }),
      ]) {
        outputs.push(await s.handleLine(line));
      }
    })();

    // Give the event loop a turn: while the first call is gated, the second
    // must not even have been DISPATCHED (the loop is still awaiting line 1).
    await new Promise((r) => setImmediate(r));
    assert.deepEqual(order, [], 'the second call has not started while the first is gated');
    release();
    await loop;
    assert.equal(parse(outputs[0]).id, 1);
    assert.equal(parse(outputs[1]).id, 2);
    assert.deepEqual(order, ['slow-done', 'fast-done']);
  });
});
