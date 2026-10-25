#!/usr/bin/env node
// MCP (Model Context Protocol) server for Radio Markec -- a standalone stdio
// JSON-RPC 2.0 process an AI client (Claude Desktop & friends) launches and
// talks to over stdin/stdout:
//
//   node src/mcp/server.js        (npm run mcp)
//
// It imports the station's existing store/service modules DIRECTLY (never
// the Fastify route registrars as routes, never src/server/index.js, never
// the scheduler loop) and answers 25 tools -- see src/mcp/tools.js for the
// catalog and docs/mcp-server.md (Slovenian) for the operator contract.
//
// STDOUT PURITY is this file's entire correctness contract: the JSON-RPC
// stream on stdout must carry NOTHING but responses. logger.js's log()
// console.log's (logger.js:34) and several backend paths call it
// (scheduleUtil.js:56, updateNowPlaying.js:170, localLibrary.js:26,
// librarySource.js:36/48, requestQueue.js:98) -- any of those would corrupt
// the stream. So console.log is redirected to stderr BEFORE any src import
// (ESM evaluates static imports before this module's body, hence this file
// holds ZERO static imports of src code: everything src-side is dynamic,
// after the redirect). After that, createLogger('mcp') is safe and gives the
// write tools their audit trail (logs/mcp.log) on stderr.
//
// Exit codes: 0 on stdin end/close and SIGINT; 1 ONLY for pre-loop boot
// failures -- config.json unreadable does NOT count (the server stays up and
// answers every tools/call with an honest isError, the doctorCli.js:62-67
// dynamic-import precedent); mcp.enabled: false does (orchestrator decision:
// one Slovenian stderr line, then exit before the loop).
//
// No CLI flags in wave 1.
//
// First statement of the module body -- see the header. (A plain assignment;
// no import may precede it, and none does.)
console.log = (...args) => {
  console.error(...args);
};

// Broken-config handling (doctorCli.js:62-67 precedent): catch the config
// import, keep serving the static catalog, answer every call with the
// config message. The process must never die mid-protocol from a DATA
// problem -- only from the operator's explicit mcp.enabled:false.
let config = null;
let configError = null;
try {
  ({ config } = await import('../config/index.js'));
} catch (err) {
  configError = err instanceof Error ? err.message : String(err);
}

// tools.js/protocol.js hold no static src imports, so they load regardless
// of config state -- the catalog is always listable.
const { TOOLS, resolveMcpFlags } = await import('./tools.js');
const { createMcpServer } = await import('./protocol.js');

const flags = resolveMcpFlags(config); // config null (broken) -> defaults, honestly reported per-call
if (!flags.enabled) {
  console.error('MCP strežnik je onemogočen v config.json (mcp.enabled: false).');
  process.exit(1);
}

const server = createMcpServer({
  tools: TOOLS,
  serverInfo: { name: 'radioclyde-mcp', version: '0.1.0' },
  configOk: configError === null,
  configError,
  allowWriteTools: flags.allowWriteTools,
});

// One line in -> at most one line out. handleLine is awaited before the
// next line is read (sequential by construction); the busy chain guarantees
// ordering even if readline buffers several lines in one chunk -- and that
// only ONE response write is ever in flight.
const readline = (await import('node:readline')).createInterface({ input: process.stdin });
let busy = Promise.resolve();

readline.on('line', (line) => {
  busy = busy
    .then(async () => {
      const response = await server.handleLine(line);
      // The ONLY process.stdout.write in src/mcp/*.
      if (response !== null) process.stdout.write(response + '\n');
    })
    .catch((err) => {
      console.error(`MCP: nepričakovana napaka pri obdelavi vrstice: ${err?.message ?? err}`);
    });
});

function shutdown() {
  // Drain whatever call is still in flight, then exit 0 -- stdin ended or
  // the operator interrupted; both are clean shutdowns, not failures.
  busy.catch(() => {}).then(() => process.exit(0));
}
readline.on('close', shutdown);
process.on('SIGINT', shutdown);
