// Config-guard tests for the MCP server (src/mcp/tools.js + src/mcp/server.js):
//   A. resolveMcpFlags -- the missing-block-means-enabled contract
//      (config.mcp absent -> both true; explicit false opts out).
//   B. the catalog imports and lists with ZERO config (tools.js holds no
//      static src imports -- pinned structurally, since stdout purity and
//      the broken-config behavior both depend on it).
//   C. server.js boot gates, pinned by SPAWNING the real entry point:
//      mcp.enabled:false -> one Slovenian stderr line, exit 1, no stdout;
//      broken/missing config.json -> the process still speaks the protocol
//      (initialize + tools/list + ping fine) and every tools/call answers
//      isError "config.json ni uporaben: ..." (the F2 lesson, pinned at the
//      MCP layer), exit 0 on stdin end.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { setupTestConfig, repoRoot } from './fixtures.mjs';

// JSON.stringify drops undefined-valued keys (the configGuards.test.mjs
// trick): {mcp: undefined} writes a config.json that genuinely LACKS the
// block -- the shipped default state.
const cfg = setupTestConfig('mcp-config-guards', { mcp: undefined });

const { TOOLS, resolveMcpFlags } = await import('../src/mcp/tools.js');
const { createMcpServer } = await import('../src/mcp/protocol.js');

const REPO = repoRoot();
const CONFIG_PATH = path.join(REPO, 'config.json');
const ORIGINAL_CONFIG = JSON.stringify(cfg, null, 2);

describe('resolveMcpFlags (the guard contract)', () => {
  test('missing config, missing block, and true all mean enabled', () => {
    assert.deepEqual(resolveMcpFlags(undefined), { enabled: true, allowWriteTools: true });
    assert.deepEqual(resolveMcpFlags({}), { enabled: true, allowWriteTools: true });
    assert.deepEqual(resolveMcpFlags({ mcp: undefined }), { enabled: true, allowWriteTools: true });
    assert.deepEqual(resolveMcpFlags({ mcp: {} }), { enabled: true, allowWriteTools: true });
    assert.deepEqual(resolveMcpFlags({ mcp: { enabled: true } }), { enabled: true, allowWriteTools: true });
  });

  test('each flag opts out only on an explicit false', () => {
    assert.deepEqual(resolveMcpFlags({ mcp: { enabled: false } }), { enabled: false, allowWriteTools: true });
    assert.deepEqual(resolveMcpFlags({ mcp: { allowWriteTools: false } }), { enabled: true, allowWriteTools: false });
    assert.deepEqual(
      resolveMcpFlags({ mcp: { enabled: false, allowWriteTools: false } }),
      { enabled: false, allowWriteTools: false }
    );
    // Truthy junk is not "false" -- the !== false guard (lyrics/push precedent).
    assert.deepEqual(resolveMcpFlags({ mcp: { enabled: 'no' } }), { enabled: true, allowWriteTools: true });
  });

  test('the fixtures-written config really lacks the block, and defaults hold on the real object', async () => {
    const { config } = await import('../src/config/index.js');
    assert.equal(config.mcp, undefined, 'fixtures wrote no mcp block');
    assert.deepEqual(resolveMcpFlags(config), { enabled: true, allowWriteTools: true });
  });
});

describe('catalog survives a missing config (static import surface)', () => {
  test('tools.js has no static src imports -- node:path and ./protocol.js only', () => {
    const src = fs.readFileSync(path.join(REPO, 'src/mcp/tools.js'), 'utf8');
    const imports = [...src.matchAll(/^import .*$/gm)].map((m) => m[0]);
    assert.ok(imports.length > 0);
    for (const line of imports) {
      // Only core node:path and the protocol error class may be static --
      // every src module must stay dynamic (lazy backend) so the catalog
      // never drags config.json in at import time.
      assert.match(
        line,
        /^import (?:\w+|\{[^}]*\}) from '(?:node:path|\.\/protocol\.js)';$/,
        `unexpected static import in tools.js: ${line}`
      );
    }
  });

  test('tools/list answers all 25 tools with no config.json on disk at all', async () => {
    // tools.js was imported above while config.json existed, but the catalog
    // itself never touched it: prove it by listing with the file gone.
    fs.rmSync(CONFIG_PATH, { force: true });
    try {
      const server = createMcpServer({ tools: TOOLS });
      const res = JSON.parse(await server.handleLine(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' })));
      assert.equal(res.result.tools.length, 25);
    } finally {
      fs.writeFileSync(CONFIG_PATH, ORIGINAL_CONFIG);
    }
  });
});

// ---------------------------------------------------------------------------
// Real-entry-point boot gates. Each case spawns `node src/mcp/server.js`
// with a deliberately prepared repo-root config.json (module-relative read,
// exactly what the station itself does) and restores it afterwards.
function runServer({ stdinLines = [] } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['src/mcp/server.js'], {
      cwd: REPO,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => (stdout += chunk));
    child.stderr.on('data', (chunk) => (stderr += chunk));
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout, stderr }));
    for (const line of stdinLines) child.stdin.write(line + '\n');
    child.stdin.end();
  });
}

describe('server.js boot gate: mcp.enabled false (orchestrator decision)', () => {
  test('one Slovenian stderr line, exit 1 before the loop, stdout stays empty', async () => {
    fs.writeFileSync(CONFIG_PATH, JSON.stringify({ ...cfg, mcp: { enabled: false } }, null, 2));
    try {
      const { code, stdout, stderr } = await runServer({ stdinLines: ['{"jsonrpc":"2.0","id":1,"method":"ping"}'] });
      assert.equal(code, 1, 'pre-loop boot failure exits 1');
      assert.equal(stdout, '', 'nothing on the JSON-RPC stream before the refusal');
      assert.match(stderr, /MCP strežnik je onemogočen v config\.json \(mcp\.enabled: false\)\./);
    } finally {
      fs.writeFileSync(CONFIG_PATH, ORIGINAL_CONFIG);
    }
  });
});

describe('server.js with a broken config.json (the F2 lesson at the MCP layer)', () => {
  test('protocol still answers; every tools/call is an honest isError; exit 0 on stdin end', async () => {
    fs.rmSync(CONFIG_PATH, { force: true });
    try {
      const { code, stdout, stderr } = await runServer({
        stdinLines: [
          JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } }),
          JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
          JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }),
          JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'station_identity' } }),
          JSON.stringify({ jsonrpc: '2.0', id: 4, method: 'ping' }),
        ],
      });
      assert.equal(code, 0, 'stdin end is a clean shutdown, not a failure');
      const lines = stdout.split('\n').filter((l) => l.trim());
      assert.equal(lines.length, 4, 'initialize, tools/list, tools/call, ping -- the notification is silent');

      const init = JSON.parse(lines[0]);
      assert.equal(init.id, 1);
      assert.equal(init.result.serverInfo.name, 'radioclyde-mcp');
      assert.equal(init.result.protocolVersion, '2025-06-18');

      const list = JSON.parse(lines[1]);
      assert.equal(list.result.tools.length, 25, 'the static catalog lists even without config');

      const call = JSON.parse(lines[2]);
      assert.equal(call.id, 3);
      assert.equal(call.result.isError, true);
      assert.match(call.result.content[0].text, /config\.json ni uporaben: /);
      assert.match(call.result.content[0].text, /config\.json not found/);

      const ping = JSON.parse(lines[3]);
      assert.deepEqual(ping.result, {});
      assert.equal(stderr, '', 'a data problem is reported in-band, not as process noise');
    } finally {
      fs.writeFileSync(CONFIG_PATH, ORIGINAL_CONFIG);
    }
  });
});

describe('server.js wiring: stdout purity (structural pins)', () => {
  test('the console.log redirect is the first statement, and the file has ZERO static imports', () => {
    const src = fs.readFileSync(path.join(REPO, 'src/mcp/server.js'), 'utf8');
    assert.equal([...src.matchAll(/^import\b/gm)].length, 0, 'no static imports: ESM hoists them before the redirect');
    // First code line (after the shebang and comments) must be the redirect.
    const code = src
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith('#!') && !l.startsWith('//'))[0];
    assert.match(code, /^console\.log = /);
    assert.match(src, /process\.exit\(1\)/, 'the enabled:false boot failure path');
    assert.match(src, /mcp\.enabled: false/, 'the exact Slovenian refusal line');
  });

  test('the single process.stdout.write lives in server.js only, never in tools/protocol', () => {
    // Strip // comments first: the headers DOCUMENT the stdout-purity rule,
    // and the pin must be about code, not prose.
    const codeOnly = (file) =>
      fs
        .readFileSync(path.join(REPO, file), 'utf8')
        .split('\n')
        .map((line) => line.replace(/\/\/.*$/, ''))
        .join('\n');
    for (const file of ['src/mcp/protocol.js', 'src/mcp/tools.js']) {
      assert.ok(!/process\.stdout\.write/.test(codeOnly(file)), `${file} must never write stdout`);
    }
    assert.equal([...codeOnly('src/mcp/server.js').matchAll(/process\.stdout\.write/g)].length, 1, 'exactly one response writer');
  });
});
