// Model Context Protocol (MCP) JSON-RPC 2.0 protocol core for Radio Markec's
// stdio server (docs/mcp-server.md). This module is PURE: no filesystem, no
// network, no console -- every input arrives as a string (one stdin line) and
// every output leaves as a string (one stdout line) or null, so the whole
// protocol surface is unit-testable without spawning a process
// (test/mcpProtocol.test.mjs).
//
// Design notes:
// - A line that parses to a JSON ARRAY is a batch request. JSON-RPC 2.0
//   allows batches, but MCP's stdio transport is specified as
//   one-message-per-line and clients that matter (Claude Desktop) never send
//   them -- answering -32600 invalid request keeps the stream honest instead
//   of half-supporting a shape the server would have to fan out.
// - Tool-level business failures are RESULT objects with isError:true and an
//   honest message (the same discipline the HTTP routes follow: a dead
//   Icecast or an unknown request id is a truthful answer, not a protocol
//   error). Protocol/harness failures (unparseable line, unknown method,
//   wrong params shape, a handler that THREW) are JSON-RPC error objects --
//   a throw never escapes as a crash (orchestrator rule).
// - id correlation is verbatim: string/number/null are echoed exactly as
//   sent; a message WITHOUT an id key is a notification and is never
//   answered, whatever its method says.
export const DEFAULT_PROTOCOL_VERSION = '2025-06-18';

// tools.js handlers signal "this is an honest business failure, not a bug"
// by throwing this class; the message becomes the isError:true content.
// Exported from here (not tools.js) so protocol.js stays free of any src
// import and both modules share one definition without a cycle.
export class ToolFailure extends Error {
  constructor(message) {
    super(message);
    this.name = 'ToolFailure';
    this.isToolFailure = true;
  }
}

function jsonrpcError(id, code, message) {
  return JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } });
}

function jsonrpcResult(id, result) {
  return JSON.stringify({ jsonrpc: '2.0', id, result });
}

// A tool call answer in MCP's shape. Success: the handler's return value
// serialized as pretty JSON text. Failure (isError:true): the honest message
// as plain text, exactly like the studio routes' { error } bodies.
function toolCallResult(value) {
  if (value && value.isError) {
    return { content: [{ type: 'text', text: String(value.message) }], isError: true };
  }
  return { content: [{ type: 'text', text: JSON.stringify(value, null, 2) }] };
}

function toolListEntry(tool) {
  return { name: tool.name, description: tool.description, inputSchema: tool.inputSchema };
}

// options:
//   tools            -- [{ name, description, inputSchema, write, handler(args, ctx) }]
//   serverInfo       -- { name, version } echoed in initialize (default radioclyde-mcp 0.1.0)
//   configOk         -- false when config.json failed to load: initialize/tools/list/ping
//                       keep working (the catalog is static), every tools/call answers
//                       isError with the config message instead of touching data
//   configError      -- the load error's message, shown when configOk is false
//   allowWriteTools  -- false (mcp.allowWriteTools: false) omits write tools from
//                       tools/list AND refuses to dispatch them with an isError that
//                       names the kill-switch
//   toolContext      -- the ctx object handed to every handler (the injectable seam:
//                       tests pass { probeIcecast, sendCommand, fetchAllTracks, now }
//                       fakes here; production passes nothing and tools.js resolves
//                       the real backend lazily)
export function createMcpServer({
  tools,
  serverInfo = { name: 'radioclyde-mcp', version: '0.1.0' },
  configOk = true,
  configError = null,
  allowWriteTools = true,
  toolContext = {},
} = {}) {
  const known = new Map((tools ?? []).map((tool) => [tool.name, tool]));

  async function callTool(id, params) {
    if (!params || typeof params !== 'object' || Array.isArray(params)) {
      return jsonrpcError(id, -32602, 'Invalid params: tools/call needs an object with "name".');
    }
    const tool = known.get(params.name);
    if (!tool) {
      return jsonrpcError(id, -32602, `Unknown tool "${params.name}" (see tools/list).`);
    }
    if (tool.write && !allowWriteTools) {
      // The kill-switch is a config fact, not a tool bug: an isError result
      // (not a protocol error) so the client can show the reason.
      return jsonrpcResult(
        id,
        toolCallResult({
          isError: true,
          message:
            'Orodje za pisanje je onemogočeno: v config.json je mcp.allowWriteTools nastavljen na false (stikalo za ustavljanje vpisov).',
        })
      );
    }
    if (!configOk) {
      return jsonrpcResult(
        id,
        toolCallResult({
          isError: true,
          message: `config.json ni uporaben: ${configError ?? 'napaka pri branju konfiguracije'}`,
        })
      );
    }
    let value;
    try {
      value = await tool.handler(params.arguments ?? {}, toolContext);
    } catch (err) {
      if (err && err.isToolFailure) {
        // Honest business failure -- the handler composed the message.
        return jsonrpcResult(id, toolCallResult({ isError: true, message: err.message }));
      }
      // A real handler bug: internal error, never a crash of the process.
      return jsonrpcError(id, -32603, `Internal error: ${err?.message ?? String(err)}`);
    }
    return jsonrpcResult(id, toolCallResult(value));
  }

  async function dispatch(message) {
    const { id, method, params } = message;
    const isNotification = !('id' in message);

    switch (method) {
      case 'initialize': {
        if (isNotification) return null;
        const requested = params && typeof params === 'object' ? params.protocolVersion : undefined;
        return jsonrpcResult(id, {
          protocolVersion:
            typeof requested === 'string' && requested ? requested : DEFAULT_PROTOCOL_VERSION,
          capabilities: { tools: {} },
          serverInfo,
        });
      }
      case 'notifications/initialized':
        // The client's hello -- a notification by definition, never answered.
        return null;
      case 'tools/list': {
        if (isNotification) return null;
        const listed = [...known.values()]
          .filter((tool) => allowWriteTools || !tool.write)
          .map(toolListEntry);
        return jsonrpcResult(id, { tools: listed });
      }
      case 'tools/call': {
        if (isNotification) return null;
        return callTool(id, params);
      }
      case 'ping': {
        if (isNotification) return null;
        return jsonrpcResult(id, {});
      }
      default:
        // Unknown REQUEST -> method not found; unknown NOTIFICATION -> ignored
        // silently (the JSON-RPC 2.0 rule for notifications we don't understand).
        if (isNotification) return null;
        return jsonrpcError(id, -32601, `Method not found: ${method}`);
    }
  }

  // One stdin line in, one stdout line out (or null when no response is due).
  // Async because a tools/call handler may await (Icecast probe, library scan);
  // the server awaits each line before reading the next, so processing is
  // sequential by construction -- no interleaved stdout writes can corrupt
  // the JSON-RPC stream.
  async function handleLine(line) {
    const trimmed = String(line ?? '').trim();
    if (!trimmed) return null; // blank line between messages -- nothing to say

    let message;
    try {
      message = JSON.parse(trimmed);
    } catch {
      return jsonrpcError(null, -32700, 'Parse error: line is not valid JSON.');
    }
    if (Array.isArray(message)) {
      // Batch -- see the header note.
      return jsonrpcError(null, -32600, 'Invalid request: batch (JSON array) messages are not supported.');
    }
    if (!message || typeof message !== 'object') {
      return jsonrpcError(null, -32600, 'Invalid request: expected a JSON-RPC 2.0 object.');
    }
    if (message.jsonrpc !== '2.0' || typeof message.method !== 'string' || !message.method) {
      // id (when the caller sent a usable one) is echoed so the client can
      // correlate the rejection with its request.
      const id = 'id' in message ? message.id : null;
      return jsonrpcError(id, -32600, 'Invalid request: missing "jsonrpc": "2.0" or "method".');
    }
    return dispatch(message);
  }

  return { handleLine };
}
