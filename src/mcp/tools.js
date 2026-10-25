// The MCP tool catalog for Radio Markec (29 tools: 17 read, 12 write) --
// the surface an AI client (Claude Desktop & friends) drives through
// src/mcp/server.js over stdio JSON-RPC. See docs/mcp-server.md (Slovenian)
// for the operator-facing contract.
//
// TRUST MODEL (deliberate, mirrors how `npm run doctor` already works):
// HTTP surfaces are gated by the listener Basic Auth (config.web.listeners,
// server/auth.js) and the studio realm (config.studio.users,
// studioAuth.js). This stdio server deliberately mirrors NEITHER: a local
// process launched by the owner's MCP client is local-trust -- it reads the
// same config.json (secrets included) the station user already owns. The
// write-side kill-switch is config.mcp.allowWriteTools: false (tools/list
// omits every write tool, a direct call is refused with an isError naming
// it), and mcp.enabled: false refuses to boot at all. If a REMOTE transport
// ever appears, this decision must be revisited first.
//
// LAYER DISCIPLINE: handlers import the station's existing store/service
// modules directly -- NEVER the Fastify route registrars as routes, never
// src/server/index.js (starts the whole station), never the scheduler loop.
// Every src import below is DYNAMIC and memoized inside loadBackend(), so
// importing this module (for tools/list) never touches config.json or the
// filesystem, and a broken config degrades to honest isError answers
// instead of a crash (server.js short-circuits calls before handlers run).
//
// DRIFT-CHECKABLE ROUTE CITATIONS (behavior mirrors these exactly):
//   studioOnAirApi.js:56-92   skip + force-next composition
//   api.js:41-56              listener count + 24 h peak
//   studioLibraryApi.js:68-83 case-insensitive substring library filter
//   studioShowsApi.js         listShowSummaries() (shared with GET /api/shows)
//   studioScheduleApi.js:75-113 schedule add/update/remove/meta route
//                             composition (+ invalidateSoon :27-33)
//
// STDOUT PURITY: logger.js's log() console.log's (logger.js:34) and several
// backend paths call it (scheduleUtil.js:56, updateNowPlaying.js:170,
// localLibrary.js:26, librarySource.js:36/48, requestQueue.js:98). server.js
// redirects console.log to stderr BEFORE any of these load; nothing in
// src/mcp/* may ever write to process.stdout except server.js's single
// response writer.
//
// The ctx argument of every handler is the injectable seam (the
// computeTopListened({readAired, readLedger, ...}) discipline,
// topListenedApi.js:18): tests pass { probeIcecast, sendCommand,
// fetchAllTracks, now } fakes so no test ever touches the network.
import path from 'node:path';

import { ToolFailure } from './protocol.js';

// config.mcp flags, resolved exactly like the lyrics/push guards
// (lyricsService.js:70-72, scheduler.js:248): a MISSING block means enabled
// -- only an explicit false opts out. Exported for server.js's boot gate and
// for test/mcpConfigGuard.test.mjs.
export function resolveMcpFlags(config) {
  return {
    enabled: config?.mcp?.enabled !== false,
    allowWriteTools: config?.mcp?.allowWriteTools !== false,
  };
}

// ---------------------------------------------------------------------------
// Lazy backend: one memoized Promise.all of the (verified-inert-at-import)
// store/service modules every handler needs. See the module-inventory audit
// in the wave-14 research for why each of these is safe to import.
let backendPromise = null;
function loadBackend() {
  if (!backendPromise) {
    backendPromise = (async () => {
      const [
        configMod,
        loggerMod,
        nowPlayingMod,
        historyMod,
        upcomingMod,
        scheduleGridMod,
        scheduleUtilMod,
        stationWriterMod,
        scheduleWatchMod,
        showsApiMod,
        briefWriterMod,
        requestsStoreMod,
        pollsStoreMod,
        diagnosticsUtilMod,
        listenerSamplesMod,
        listenerImpactMod,
        librarySourceMod,
        localLibraryMod,
        plexTracksMod,
        ratingKeyIndexMod,
        imagingPlaylistsMod,
        voiceStatusMod,
        streamUrlsMod,
        listenFilesMod,
        deadAirLedgerMod,
        onAirApiMod,
        requestQueueMod,
      ] = await Promise.all([
        import('../config/index.js'),
        import('../lib/logger.js'),
        import('../server/nowPlaying.js'),
        import('../server/historyApi.js'),
        import('../server/upcoming.js'),
        import('../server/scheduleGrid.js'),
        import('../scheduler/scheduleUtil.js'),
        // Schedule/station-meta write levers (stationWriter) + the stale-
        // production invalidation check the studio routes run inline after
        // every write (scheduleWatch). Both inert at import (verified: no
        // fs.watch, no timers; createLogger computes a path only).
        import('../scheduler/stationWriter.js'),
        import('../scheduler/scheduleWatch.js'),
        import('../server/studioShowsApi.js'),
        import('../producer/showBriefWriter.js'),
        import('../server/requestsStore.js'),
        import('../server/pollsStore.js'),
        import('../server/diagnosticsUtil.js'),
        import('../analytics/listenerSamples.js'),
        import('../analytics/listenerImpact.js'),
        import('../auto/librarySource.js'),
        import('../auto/localLibrary.js'),
        import('../plex/tracks.js'),
        import('../plex/ratingKeyIndex.js'),
        import('../scheduler/imagingPlaylists.js'),
        import('../server/voiceStatus.js'),
        import('../server/streamUrls.js'),
        import('../server/listenFiles.js'),
        import('../deadair/ledger.js'),
        // skipCommandForMount lives in the On Air route module (exported,
        // pure on purpose -- studioOnAirApi.js:24); importing the registrar
        // is inert and keeps ONE source of truth for the skip command shape.
        import('../server/studioOnAirApi.js'),
        import('../liquidsoap/requestQueue.js'),
      ]);
      return {
        config: configMod.config,
        audit: loggerMod.createLogger('mcp'), // logs/mcp.log audit trail (write tools)
        composeNowPlaying: nowPlayingMod.composeNowPlaying,
        getRecentHistory: historyMod.getRecentHistory,
        getUpcomingShows: upcomingMod.getUpcomingShows,
        buildWeeklyGrid: scheduleGridMod.buildWeeklyGrid,
        loadSchedule: scheduleUtilMod.loadSchedule,
        loadStation: scheduleUtilMod.loadStation,
        addOccurrence: stationWriterMod.addOccurrence,
        updateOccurrence: stationWriterMod.updateOccurrence,
        removeOccurrence: stationWriterMod.removeOccurrence,
        updateStationMeta: stationWriterMod.updateStationMeta,
        checkScheduleChanged: scheduleWatchMod.checkScheduleChanged,
        listShowSummaries: showsApiMod.listShowSummaries,
        readShowBriefForEditing: briefWriterMod.readShowBriefForEditing,
        validateSubmission: requestsStoreMod.validateSubmission,
        appendRequest: requestsStoreMod.appendRequest,
        getRequest: requestsStoreMod.getRequest,
        publicView: requestsStoreMod.publicView,
        updateRequestStatus: requestsStoreMod.updateRequestStatus,
        listRequests: requestsStoreMod.listRequests,
        validatePollInput: pollsStoreMod.validatePollInput,
        createPoll: pollsStoreMod.createPoll,
        votePoll: pollsStoreMod.votePoll,
        closeActivePoll: pollsStoreMod.closeActivePoll,
        activePollSummary: pollsStoreMod.activePollSummary,
        pollHistory: pollsStoreMod.pollHistory,
        readStore: pollsStoreMod.readStore,
        probeIcecast: diagnosticsUtilMod.probeIcecast,
        playlistStats: diagnosticsUtilMod.playlistStats,
        tailFile: diagnosticsUtilMod.tailFile,
        repeatOffenders: diagnosticsUtilMod.repeatOffenders,
        readAiredEntries: historyMod.readAiredEntries,
        readSamples: listenerSamplesMod.readSamples,
        peakListeners: listenerImpactMod.peakListeners,
        fetchAllTracksAny: librarySourceMod.fetchAllTracksAny,
        musicSource: librarySourceMod.musicSource,
        allLocalTracks: localLibraryMod.allLocalTracks,
        getTrackByRatingKey: plexTracksMod.getTrackByRatingKey,
        lookupRatingKey: ratingKeyIndexMod.lookupRatingKey,
        buildImagingEntries: imagingPlaylistsMod.buildImagingEntries,
        LAYER_TAGS: imagingPlaylistsMod.LAYER_TAGS,
        voiceStatus: voiceStatusMod.voiceStatus,
        streamEntries: streamUrlsMod.streamEntries,
        resolveStreamUrl: streamUrlsMod.resolveStreamUrl,
        m3uBody: listenFilesMod.m3uBody,
        plsBody: listenFilesMod.plsBody,
        deadAirSummary: deadAirLedgerMod.deadAirSummary,
        skipCommandForMount: onAirApiMod.skipCommandForMount,
        sendCommand: (await import('../liquidsoap/telnetClient.js')).sendCommand,
        forceNextOccurrence: (await import('../scheduler/updateNowPlaying.js')).forceNextOccurrence,
        queueRequest: requestQueueMod.queueRequest,
      };
    })();
  }
  return backendPromise;
}

// ---------------------------------------------------------------------------
// Small argument helpers (handler-side tolerance for loose clients; the
// stores still clamp defensively on their own).
function intArg(args, key, { min, max, fallback }) {
  if (args == null || args[key] === undefined || args[key] === null) return fallback;
  const n = Number(args[key]);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(Math.trunc(n), max));
}

function requireString(args, key, message) {
  const value = args?.[key];
  if (typeof value !== 'string' || !value.trim()) throw new ToolFailure(message);
  return value.trim();
}

// The exact list the studio Diagnostics view tails (studioDiagnosticsApi.js:25).
const LOG_FILES = ['web.log', 'station.log', 'scheduler.log'];

// Library snapshot cache, mirroring studioLibraryApi's 60 s librarySnapshot()
// (:22-64 -- not exported, hence re-implemented here): a full scan reads
// every file's tags, so seconds of IO must not repeat per query. Keyed on the
// fetch function's identity, so an injected test fake is a different key and
// never sees stale production data.
const SCAN_CACHE_TTL_MS = 60 * 1000;
const scanCache = { fn: null, at: 0, tracks: null, promise: null, promiseFn: null };
async function fetchAllTracksCached(fetchAll) {
  if (scanCache.fn === fetchAll && scanCache.tracks && Date.now() - scanCache.at < SCAN_CACHE_TTL_MS) {
    return scanCache.tracks;
  }
  // Single-flight per fetch FUNCTION: a caller riding an in-flight scan must
  // never receive a different function's promise (the promiseFn guard -- a
  // bare "is any scan in flight" check would hand fn A's caller fn B's result).
  if (scanCache.promise && scanCache.promiseFn === fetchAll) return scanCache.promise;
  const promise = (async () => {
    try {
      const tracks = await fetchAll();
      scanCache.fn = fetchAll;
      scanCache.at = Date.now();
      scanCache.tracks = tracks;
      return tracks;
    } finally {
      if (scanCache.promise === promise) scanCache.promise = null;
    }
  })();
  scanCache.promise = promise;
  scanCache.promiseFn = fetchAll;
  return promise;
}

// ---------------------------------------------------------------------------
// READ TOOLS
const nowPlayingTool = {
  name: 'now_playing',
  description:
    'What is on air right now: station block (name, stream URLs), current show, current track, DJ speech state, scheduled start and estimated end. Same data as GET /api/now-playing.',
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  write: false,
  handler: async () => {
    const be = await loadBackend();
    return be.composeNowPlaying();
  },
};

const playHistoryTool = {
  name: 'play_history',
  description:
    'Recently aired tracks (newest first), from the real scrobble ledger (history/aired.jsonl). Same projection as GET /api/history.',
  inputSchema: {
    type: 'object',
    properties: {
      limit: { type: 'integer', minimum: 0, maximum: 200, default: 50 },
    },
    additionalProperties: false,
  },
  write: false,
  handler: async (args) => {
    const be = await loadBackend();
    const limit = intArg(args, 'limit', { min: 0, max: 200, fallback: undefined });
    return { entries: be.getRecentHistory(limit) };
  },
};

const upcomingShowsTool = {
  name: 'upcoming_shows',
  description: 'The next scheduled show occurrences (id, name, host, weekday, date, start time). Same data as GET /api/upcoming.',
  inputSchema: {
    type: 'object',
    properties: {
      count: { type: 'integer', minimum: 1, maximum: 50, default: 10 },
    },
    additionalProperties: false,
  },
  write: false,
  handler: async (args) => {
    const be = await loadBackend();
    return { shows: be.getUpcomingShows(intArg(args, 'count', { min: 1, max: 50, fallback: 10 })) };
  },
};

const weeklyScheduleTool = {
  name: 'weekly_schedule',
  description:
    'The 7-day programme grid straight from station.json (same data as GET /api/schedule). Caveat: the on-air/next marks are TEMPLATE-relative (what the weekly lineup says at this instant), not playback truth -- live overruns are not modelled; now_playing is the real on-air truth.',
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  write: false,
  handler: async () => {
    const be = await loadBackend();
    return be.buildWeeklyGrid(be.loadSchedule(), new Date());
  },
};

const listShowsTool = {
  name: 'list_shows',
  description:
    'Every show brief in the library (show-descriptions/*.md): id, title, personas, segments, first scheduled duration. Same data as GET /api/shows.',
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  write: false,
  handler: async () => {
    const be = await loadBackend();
    return { shows: be.listShowSummaries() };
  },
};

const showDetailTool = {
  name: 'show_detail',
  description:
    'One show brief in full (the editing round-trip view: description, hosts, track selection, tone, quiz, weather). Same data as GET /api/shows/:id.',
  inputSchema: {
    type: 'object',
    properties: { id: { type: 'string' } },
    required: ['id'],
    additionalProperties: false,
  },
  write: false,
  handler: async (args) => {
    const be = await loadBackend();
    const id = requireString(args, 'id', 'Manjka "id" oddaje.');
    try {
      return be.readShowBriefForEditing(id);
    } catch (err) {
      throw new ToolFailure(err.message);
    }
  },
};

const requestsListTool = {
  name: 'requests_list',
  description:
    'Listener song requests and dedications, newest first, with status and moderation note (the studio moderation queue). Optional status filter.',
  inputSchema: {
    type: 'object',
    properties: {
      status: { type: 'string', enum: ['pending', 'approved', 'rejected'] },
      limit: { type: 'integer', minimum: 0, maximum: 500, default: 500 },
    },
    additionalProperties: false,
  },
  write: false,
  handler: async (args) => {
    const be = await loadBackend();
    const status = args?.status;
    if (status !== undefined && !['pending', 'approved', 'rejected'].includes(status)) {
      throw new ToolFailure('Neznan status (dovoljeno: pending, approved, rejected).');
    }
    const limit = intArg(args, 'limit', { min: 0, max: 500, fallback: 500 });
    return { requests: be.listRequests({ status: status ?? undefined, limit }) };
  },
};

const requestGetTool = {
  name: 'request_get',
  description: 'One listener request by id, with its full moderation state and note.',
  inputSchema: {
    type: 'object',
    properties: { id: { type: 'string' } },
    required: ['id'],
    additionalProperties: false,
  },
  write: false,
  handler: async (args) => {
    const be = await loadBackend();
    const id = requireString(args, 'id', 'Manjka "id" zahtevka.');
    const entry = be.getRequest(id);
    if (!entry) throw new ToolFailure('Zahtevek s tem ID ne obstaja.');
    return entry;
  },
};

const pollsActiveTool = {
  name: 'polls_active',
  description:
    'The active listener poll with its honest tally (null when none is open). Same data as GET /api/polls/active.',
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  write: false,
  handler: async () => {
    const be = await loadBackend();
    return { poll: be.activePollSummary() };
  },
};

const pollsHistoryTool = {
  name: 'polls_history',
  description: 'Closed polls, newest first, with frozen tallies (the studio Ankete history view).',
  inputSchema: {
    type: 'object',
    properties: {
      limit: { type: 'integer', minimum: 1, maximum: 100, default: 10 },
    },
    additionalProperties: false,
  },
  write: false,
  handler: async (args) => {
    const be = await loadBackend();
    return { closed: be.pollHistory(intArg(args, 'limit', { min: 1, max: 100, fallback: 10 })) };
  },
};

const listenerStatsTool = {
  name: 'listener_stats',
  description:
    'Live listener count (only when Icecast actually answered -- null otherwise, never an invented number) plus the 24 h peak from the sampling ledger. A dead Icecast is an honest result carrying the error text, not a failure.',
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  write: false,
  handler: async (args, ctx) => {
    const be = await loadBackend();
    const probe = ctx?.probeIcecast ?? be.probeIcecast;
    const now = ctx?.now ?? Date.now();
    // GET /api/listeners composition (api.js:41-56): the peak rides along
    // even while Icecast is down; its own failure never fails the call.
    let peak = null;
    try {
      peak = be.peakListeners(be.readSamples(), { from: now - 24 * 60 * 60 * 1000, to: now });
    } catch {
      peak = null;
    }
    const icecast = await probe(`http://${be.config.icecast.sourceHost}:${be.config.icecast.port}`);
    return { listeners: icecast.healthy ? icecast.listeners : null, peak, icecast };
  },
};

const librarySearchTool = {
  name: 'library_search',
  description:
    'Case-insensitive substring search over the music library (artist, title, album), whichever source the station runs (Plex or local folders). A full scan is cached for 60 s, mirroring the studio library view.',
  inputSchema: {
    type: 'object',
    properties: {
      query: { type: 'string', minLength: 1 },
      limit: { type: 'integer', minimum: 1, maximum: 200, default: 50 },
    },
    required: ['query'],
    additionalProperties: false,
  },
  write: false,
  handler: async (args, ctx) => {
    const be = await loadBackend();
    const query = requireString(args, 'query', 'Manjka iskalni niz "query".');
    const limit = intArg(args, 'limit', { min: 1, max: 200, fallback: 50 });
    const fetchAll = ctx?.fetchAllTracks ?? be.fetchAllTracksAny;
    const tracks = await fetchAllTracksCached(fetchAll);
    // The studio library filter (studioLibraryApi.js:68-83): substring match
    // on artist/title/album, lowercased.
    const q = query.toLowerCase();
    const filtered = tracks.filter(
      (t) =>
        String(t.artist ?? '').toLowerCase().includes(q) ||
        String(t.title ?? '').toLowerCase().includes(q) ||
        String(t.album ?? '').toLowerCase().includes(q)
    );
    const rows = filtered
      .map((t) => ({
        ratingKey: t.ratingKey ?? null,
        artist: t.artist ?? '',
        title: t.title ?? '',
        album: t.album ?? '',
        genres: t.genre ?? [],
        durationSeconds: t.durationMs ? t.durationMs / 1000 : null,
      }))
      .sort((a, b) => a.artist.localeCompare(b.artist) || a.title.localeCompare(b.title));
    return { total: tracks.length, filteredTotal: filtered.length, tracks: rows.slice(0, limit) };
  },
};

const trackMetadataTool = {
  name: 'track_metadata',
  description:
    'Full metadata for one track, addressed EITHER by rating_key (Plex id / local sha1-of-path) or by local_path (resolved through the scrobble side index on Plex). Pass exactly one of the two.',
  inputSchema: {
    type: 'object',
    properties: {
      rating_key: { type: 'string' },
      local_path: { type: 'string' },
    },
    additionalProperties: false,
  },
  write: false,
  handler: async (args) => {
    const be = await loadBackend();
    const ratingKey = typeof args?.rating_key === 'string' && args.rating_key.trim() ? args.rating_key.trim() : null;
    const localPath = typeof args?.local_path === 'string' && args.local_path.trim() ? args.local_path.trim() : null;
    if (ratingKey && localPath) {
      throw new ToolFailure('Podaj bodisi rating_key bodisi local_path, ne oboje hkrati.');
    }
    if (!ratingKey && !localPath) {
      throw new ToolFailure('Podaj rating_key ali local_path.');
    }
    // Same routing the rest of the station uses -- musicSource() is the
    // one source of truth (librarySource.js:22-24).
    const source = be.musicSource();
    if (source === 'local') {
      const all = await be.allLocalTracks();
      const track = ratingKey
        ? all.find((t) => t.ratingKey === ratingKey)
        : all.find((t) => t.localPath === localPath);
      if (!track) {
        throw new ToolFailure(`Skladja ni v lokalni knjižnici (${ratingKey ?? localPath}).`);
      }
      return { source: 'local', track };
    }
    if (ratingKey) {
      try {
        return { source: 'plex', track: await be.getTrackByRatingKey(ratingKey) };
      } catch (err) {
        throw new ToolFailure(err.message);
      }
    }
    // Reverse map: m3u paths carry no ratingKey; the scrobble side index
    // (track_ratingkeys.json, read-only fail-open) knows the mapping.
    const mapped = be.lookupRatingKey(localPath);
    if (!mapped) {
      throw new ToolFailure(`Za pot "${localPath}" ni znanega ratingKey (index track_ratingkeys.json).`);
    }
    try {
      return { source: 'plex', track: await be.getTrackByRatingKey(mapped) };
    } catch (err) {
      throw new ToolFailure(err.message);
    }
  },
};

const imagingInventoryTool = {
  name: 'imaging_inventory',
  description:
    'Inventory of the imaging layer clip directories (station IDs, stingers, emergency bed): clip counts and file lists per layer, with an honest dirMissing flag. Read-only -- it never rewrites the .m3u files radio.liq watches.',
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  write: false,
  handler: async () => {
    const be = await loadBackend();
    const layers = [
      { name: 'id', dir: be.config.paths.imagingIdDir },
      { name: 'stingers', dir: be.config.paths.imagingStingerDir },
      { name: 'emergency', dir: be.config.paths.imagingEmergencyDir },
    ];
    const out = {};
    for (const { name, dir } of layers) {
      // buildImagingEntries is the pure read half of imagingPlaylists.js
      // (:57); writeImagingPlaylists() is deliberately NEVER called.
      const { entries, dirMissing } = be.buildImagingEntries(dir);
      out[name] = { tag: be.LAYER_TAGS[name], dir, dirMissing, count: entries.length, entries };
    }
    return { layers: out };
  },
};

const voiceDropsTool = {
  name: 'voice_drops',
  description:
    'Voice subsystem status: active provider mode, persona clip inventory, pre-generated slot inventory, Piper model readiness, and the configured DJ-drops gain. Same data as the studio voice status view.',
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  write: false,
  handler: async () => {
    const be = await loadBackend();
    // djDrops gain with the same guard the director applies (djAudio.js:35).
    return { ...be.voiceStatus(), djDropsGain: be.config.djDrops?.gain ?? 1 };
  },
};

const stationIdentityTool = {
  name: 'station_identity',
  description:
    'Station identity and every published stream URL: name, stream entries (MP3 floor + enabled optional mounts), the /listen.m3u and /listen.pls bodies, Icecast mount and web port.',
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  write: false,
  handler: async () => {
    const be = await loadBackend();
    return {
      name: be.loadStation().name ?? be.config.autoRadio?.stationName ?? null,
      streamUrl: be.resolveStreamUrl(),
      streams: be.streamEntries(),
      listenM3u: be.m3uBody(),
      listenPls: be.plsBody(),
      icecast: { mount: be.config.icecast?.mount ?? null, sourcePort: be.config.icecast?.port ?? null },
      webPort: be.config.web?.port ?? null,
    };
  },
};

const componentHealthTool = {
  name: 'component_health',
  description:
    'Health snapshot: Icecast probe (honest failure text when down), generated-playlist stats (now_playing/filler mtimes), dead-air guard summary, rotation repeat offenders, and the tails of web/station/scheduler logs. Log tails are the cross-process truth (set include_logs:false to skip them).',
  inputSchema: {
    type: 'object',
    properties: {
      include_logs: { type: 'boolean', default: true },
    },
    additionalProperties: false,
  },
  write: false,
  handler: async (args, ctx) => {
    const be = await loadBackend();
    const probe = ctx?.probeIcecast ?? be.probeIcecast;
    const includeLogs = args?.include_logs !== false;

    const icecast = await probe(`http://${be.config.icecast.sourceHost}:${be.config.icecast.port}`);

    const logs = {};
    if (includeLogs) {
      for (const name of LOG_FILES) {
        const lines = be.tailFile(path.join(be.config.paths.logsDir, name), 40);
        if (lines.length) logs[name] = lines;
      }
    }

    const windowHours = be.config.filler?.rotationWindowHours ?? 24;
    return {
      generatedAt: new Date().toISOString(),
      stream: { icecast, mount: be.config.icecast?.mount ?? null },
      playlists: {
        nowPlaying: be.playlistStats(be.config.paths.nowPlayingPath),
        filler: be.playlistStats(be.config.paths.fillerPath),
      },
      deadAir: be.deadAirSummary(),
      repeats: { windowHours, offenders: be.repeatOffenders(be.readAiredEntries(), windowHours) },
      logs,
      // HONESTY: recentErrors() (lib/errorRing.js) is an in-memory ring in
      // the WEB process -- from this separate MCP process it would always
      // read empty, so it is deliberately NOT included. The log tails above
      // are the cross-process truth (studioDiagnosticsApi.js surfaces both).
    };
  },
};

// ---------------------------------------------------------------------------
// WRITE TOOLS (all mutate shared state through the existing atomic writers;
// config.mcp.allowWriteTools: false hides them from tools/list and refuses
// direct calls server-side)

// studioScheduleApi.js:27-33 mirror: run scheduleWatch's invalidation check
// inline right after a schedule/meta write, instead of waiting for the station
// process's next scheduleWatch tick. Best-effort by design -- a throw here
// must never fail an already-successful atomic write (route comment :26).
// Cross-process notes: the route's "both processes are the same one now"
// comment (studioScheduleApi.js:22-24) is about web+scheduler; this MCP
// server is a separate process, but the mechanism is fully file-mediated
// (station.json's sha256 vs .station_hash, atomic tmp+rename writes, and
// rmSync({ recursive, force }) sweeps that are idempotent), so calling it
// from here is equally safe. Even if it throws or is skipped, the station
// process's own scheduleWatchIntervalMinutes tick picks the change up. The
// log() calls inside scheduleWatch console.log onto stderr here (server.js's
// console.log redirect), never onto the JSON-RPC stream.
function invalidateSoon(be) {
  try {
    be.checkScheduleChanged();
  } catch {
    // the station process's next scheduleWatch tick picks it up
  }
}

const requestAddTool = {
  name: 'request_add',
  description:
    'File a song request or dedication on behalf of the owner. Validation is the listener form\'s own (Slovenian errors on bad input); the per-IP listener rate limit is deliberately NOT applied -- this is an owner action, recorded with ip "mcp" for provenance.',
  inputSchema: {
    type: 'object',
    properties: {
      type: { type: 'string', enum: ['request', 'dedication'], default: 'request' },
      title: { type: 'string', maxLength: 200 },
      artist: { type: 'string', maxLength: 200 },
      message: { type: 'string', maxLength: 500 },
      from: { type: 'string', maxLength: 80 },
    },
    additionalProperties: false,
  },
  write: true,
  handler: async (args, ctx) => {
    const be = await loadBackend();
    const body = {
      type: args?.type ?? 'request',
      title: args?.title,
      artist: args?.artist,
      message: args?.message,
      from: args?.from,
    };
    // requestsApi.js:12-22 precedent (validation -> append -> publicView),
    // minus the per-IP gate (owner action, see description).
    const check = be.validateSubmission(body);
    if (!check.ok) throw new ToolFailure(check.errors.join(' '));
    const entry = be.appendRequest(body, 'mcp', ctx?.now !== undefined ? new Date(ctx.now) : undefined);
    be.audit(`request_add: "${entry.title}" (${entry.id})`);
    return be.publicView(entry);
  },
};

const requestModerateTool = {
  name: 'request_moderate',
  description:
    'Approve or reject a listener request (owner moderation). A decided request can still flip approved<->rejected, but never returns to pending. Optional note (max 300 chars) is shown to the listener.',
  inputSchema: {
    type: 'object',
    properties: {
      id: { type: 'string' },
      status: { type: 'string', enum: ['approved', 'rejected'] },
      note: { type: 'string', maxLength: 300 },
    },
    required: ['id', 'status'],
    additionalProperties: false,
  },
  write: true,
  handler: async (args) => {
    const be = await loadBackend();
    const id = requireString(args, 'id', 'Manjka "id" zahtevka.');
    const status = args?.status;
    if (status !== 'approved' && status !== 'rejected') {
      throw new ToolFailure('Neznan status (dovoljeno: approved, rejected).');
    }
    // studioRequestsApi.js:19-33 messages, mapped one-to-one.
    const updated = be.updateRequestStatus(id, status, args?.note ?? '');
    if (!updated) throw new ToolFailure('Zahtevek ne obstaja.');
    if (updated.invalid) throw new ToolFailure('Zahtevek je že odločen -- vrnitev v "pending" ni mogoča.');
    be.audit(`request_moderate: ${id} -> ${status}`);
    return updated;
  },
};

const requestQueueTool = {
  name: 'request_queue',
  description:
    'Push an ALREADY approved request onto Liquidsoap\'s request queue so it airs at the next track boundary. Resolves the song against the library first; every outcome (queued / not in library / Liquidsoap unreachable) is written into the request\'s note. Touches the network (library + telnet).',
  inputSchema: {
    type: 'object',
    properties: { id: { type: 'string' } },
    required: ['id'],
    additionalProperties: false,
  },
  write: true,
  handler: async (args) => {
    const be = await loadBackend();
    const id = requireString(args, 'id', 'Manjka "id" zahtevka.');
    // studioRequestsApi.js:40-45 precedent.
    const outcome = await be.queueRequest(id);
    if (!outcome) throw new ToolFailure('Zahtevek ne obstaja.');
    if (!outcome.ok) throw new ToolFailure(outcome.error);
    be.audit(`request_queue: ${id} -> Liquidsoap request #${outcome.requestId}`);
    return outcome;
  },
};

const pollCreateTool = {
  name: 'poll_create',
  description:
    'Open a new listener poll (closing any previous active one -- one active poll at a time). Validation is the studio form\'s own: 2-6 non-empty, distinct options; question up to 200 chars.',
  inputSchema: {
    type: 'object',
    properties: {
      question: { type: 'string', minLength: 1, maxLength: 200 },
      options: {
        type: 'array',
        items: { type: 'string', minLength: 1, maxLength: 80 },
        minItems: 2,
        maxItems: 6,
      },
    },
    required: ['question', 'options'],
    additionalProperties: false,
  },
  write: true,
  handler: async (args, ctx) => {
    const be = await loadBackend();
    // pollsApi.js:67-73 precedent.
    const check = be.validatePollInput(args);
    if (!check.ok) throw new ToolFailure(check.errors.join(' '));
    const poll = be.createPoll({ question: args.question, options: args.options }, ctx?.now);
    be.audit(`poll_create: "${poll.question}" (${poll.id})`);
    return { ok: true, poll };
  },
};

const pollVoteTool = {
  name: 'poll_vote',
  description:
    'Cast one vote on the active poll (option = index into its options). The active poll\'s id is resolved server-side; pass id only to vote a SPECIFIC poll. The HTTP layer\'s per-IP 30 s cooldown is deliberately not mirrored -- an owner-side vote is not flood traffic.',
  inputSchema: {
    type: 'object',
    properties: {
      option: { type: 'integer', minimum: 0, maximum: 5 },
      id: { type: 'string' },
    },
    required: ['option'],
    additionalProperties: false,
  },
  write: true,
  handler: async (args) => {
    const be = await loadBackend();
    const option = Number(args?.option);
    if (!Number.isInteger(option)) {
      throw new ToolFailure('Manjka ali neveljavna "option" (indeks možnosti).');
    }
    // Active poll id resolved server-side; votePoll itself refuses
    // no-active / unknown-id / bad-option honestly.
    const targetId = typeof args?.id === 'string' && args.id ? args.id : be.readStore().active?.id;
    const result = be.votePoll(targetId, option);
    if (!result.ok) {
      const messages = {
        'no-active': 'Trenutno ni aktivne ankete.',
        'unknown-id': 'Anketa s tem ID ni (več) aktivna.',
        'bad-option': 'Neveljavna možnost glasovanja.',
      };
      throw new ToolFailure(messages[result.reason] ?? `Glasovanje ni uspelo (${result.reason}).`);
    }
    be.audit(`poll_vote: option ${option} (skupno ${result.tally.total})`);
    return { ok: true, tally: result.tally };
  },
};

const pollCloseTool = {
  name: 'poll_close',
  description:
    'Close the active poll (owner action): freezes the tally into history and stops the on-air rubric from mentioning it. Honest failure when no poll is open.',
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  write: true,
  handler: async (args, ctx) => {
    const be = await loadBackend();
    // pollsApi.js:92-95 precedent.
    const result = be.closeActivePoll(ctx?.now);
    if (!result.ok) throw new ToolFailure('Trenutno ni aktivne ankete.');
    be.audit('poll_close');
    return result;
  },
};

const skipTrackTool = {
  name: 'skip_track',
  description:
    'Skip whatever is actually on the Icecast output right now (the mounted output.skip command, NOT show_source.skip). Honest refusal when no track is airing (DJ speech / dead air).',
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  write: true,
  handler: async (args, ctx) => {
    const be = await loadBackend();
    const send = ctx?.sendCommand ?? be.sendCommand;
    // POST /studio/api/on-air/skip (studioOnAirApi.js:56-67), replicated.
    const { track } = be.composeNowPlaying();
    if (!track) {
      throw new ToolFailure('Nič za preskočiti -- trenutno ni skladbe v etru.');
    }
    try {
      const result = await send(be.skipCommandForMount(be.config.icecast?.mount));
      return { result };
    } catch (err) {
      throw new ToolFailure(`Liquidsoap telnet ukaz ni uspel: ${err.message}`);
    }
  },
};

const forceNextShowTool = {
  name: 'force_next_show',
  description:
    'Force the next directed show occurrence: loads it into now_playing.m3u, reloads the show source and skips the currently-decoding file so the switch is audible immediately. Honest failure when no produced (directed) show is ready to take over.',
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  write: true,
  handler: async (args, ctx) => {
    const be = await loadBackend();
    const send = ctx?.sendCommand ?? be.sendCommand;
    // POST /studio/api/on-air/force-next (studioOnAirApi.js:69-92),
    // replicated: force -> best-effort reload -> mandatory skip.
    let state;
    try {
      state = await be.forceNextOccurrence();
    } catch (err) {
      throw new ToolFailure(err.message);
    }
    try {
      await send('show_source.reload');
    } catch {
      // watch mode may still pick the rewrite up; the skip below is the
      // part that actually interrupts (route comment, :82-84).
    }
    try {
      await send(be.skipCommandForMount(be.config.icecast?.mount));
    } catch (err) {
      throw new ToolFailure(`Liquidsoap telnet ukaz ni uspel: ${err.message}`);
    }
    return { state };
  },
};

const scheduleAddOccurrenceTool = {
  name: 'schedule_add_occurrence',
  description:
    'Add a show occurrence to one weekday\'s lineup (the same write POST /api/schedule/:weekday performs). The day is one ordered, gapless sequence: a start time that conflicts with existing slots reorders and repacks the rest of the day instead of being rejected. The show brief must already exist under show-descriptions/. Returns the whole day as written.',
  inputSchema: {
    type: 'object',
    properties: {
      weekday: {
        type: 'string',
        enum: ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'],
      },
      occurrence: {
        type: 'object',
        properties: {
          id: { type: 'string', minLength: 1 },
          startTime: { type: 'string', pattern: '^([01][0-9]|2[0-3]):[0-5][0-9]$' },
          durationMinutes: { type: 'number', exclusiveMinimum: 0 },
          description: { type: 'string' },
        },
        required: ['id', 'startTime', 'durationMinutes'],
        additionalProperties: false,
      },
    },
    required: ['weekday', 'occurrence'],
    additionalProperties: false,
  },
  write: true,
  handler: async (args) => {
    const be = await loadBackend();
    const weekday = requireString(args, 'weekday', 'Manjka "weekday" (sunday..saturday).');
    // studioScheduleApi.js:75-83 route composition: the nested occurrence
    // passes through verbatim, exactly like request.body ?? {} (:77) -- zero
    // field-list duplication, writer-side validation is the single source of
    // truth. durationMinutes is a plain number (not integer), mirroring the
    // writer's Number.isFinite && > 0 check (stationWriter.js:73);
    // description is optional because the studio UI sends it only on
    // cross-day moves (public/studio/js/schedule.js:429) and no src code
    // reads it.
    let day;
    try {
      day = await be.addOccurrence(weekday, args?.occurrence ?? {});
    } catch (err) {
      throw new ToolFailure(err.message);
    }
    invalidateSoon(be);
    be.audit(`schedule_add_occurrence: ${weekday} ${args?.occurrence?.id} @ ${args?.occurrence?.startTime}`);
    return { weekday, occurrences: day };
  },
};

const scheduleUpdateOccurrenceTool = {
  name: 'schedule_update_occurrence',
  description:
    'Change an existing occurrence -- start time, duration, or show reassignment (the same write PATCH /api/schedule/:weekday/:timeKey performs). A plain start-time move landing on another occurrence\'s slot swaps the two in place; a resize, reassignment, or move into empty space repacks the day. time_key addresses the occurrence by its CURRENT start time with ":" replaced by "-" (e.g. "08-00"). An id-changing patch requires the new show\'s brief to exist.',
  inputSchema: {
    type: 'object',
    properties: {
      weekday: {
        type: 'string',
        enum: ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'],
      },
      time_key: { type: 'string', pattern: '^([01][0-9]|2[0-3])-[0-5][0-9]$' },
      patch: {
        type: 'object',
        properties: {
          id: { type: 'string', minLength: 1 },
          startTime: { type: 'string', pattern: '^([01][0-9]|2[0-3]):[0-5][0-9]$' },
          durationMinutes: { type: 'number', exclusiveMinimum: 0 },
          description: { type: 'string' },
        },
        additionalProperties: false,
      },
    },
    required: ['weekday', 'time_key', 'patch'],
    additionalProperties: false,
  },
  write: true,
  handler: async (args) => {
    const be = await loadBackend();
    const weekday = requireString(args, 'weekday', 'Manjka "weekday" (sunday..saturday).');
    const timeKey = requireString(args, 'time_key', 'Manjka "time_key" obstoječega termina (npr. "08-00").');
    // studioScheduleApi.js:85-93 route composition: the patch passes through
    // verbatim (request.body ?? {}, :87) with zero pre-validation. A
    // malformed time_key is NOT rejected handler-side -- it honestly fails
    // inside the writer (`No occurrence at monday xx-xx to update.`),
    // mirroring the route's passthrough; the schema pattern above is
    // advisory documentation for clients only.
    let day;
    try {
      day = await be.updateOccurrence(weekday, timeKey, args?.patch ?? {});
    } catch (err) {
      throw new ToolFailure(err.message);
    }
    invalidateSoon(be);
    be.audit(`schedule_update_occurrence: ${weekday} ${timeKey}`);
    return { weekday, occurrences: day };
  },
};

const scheduleRemoveOccurrenceTool = {
  name: 'schedule_remove_occurrence',
  description:
    'Remove one occurrence from the weekday lineup (the same write DELETE /api/schedule/:weekday/:timeKey performs) and close the gap it leaves behind. Returns the removed occurrence. time_key is the occurrence\'s current start time with ":" replaced by "-" (e.g. "08-00").',
  inputSchema: {
    type: 'object',
    properties: {
      weekday: {
        type: 'string',
        enum: ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'],
      },
      time_key: { type: 'string', pattern: '^([01][0-9]|2[0-3])-[0-5][0-9]$' },
    },
    required: ['weekday', 'time_key'],
    additionalProperties: false,
  },
  write: true,
  handler: async (args) => {
    const be = await loadBackend();
    const weekday = requireString(args, 'weekday', 'Manjka "weekday" (sunday..saturday).');
    const timeKey = requireString(args, 'time_key', 'Manjka "time_key" obstoječega termina (npr. "08-00").');
    // studioScheduleApi.js:95-103 route composition: the writer's throw (no
    // such occurrence) maps to an honest ToolFailure; the route returns the
    // removed occurrence object as the whole response body (:99) -- so does
    // this tool.
    let removed;
    try {
      removed = await be.removeOccurrence(weekday, timeKey);
    } catch (err) {
      throw new ToolFailure(err.message);
    }
    invalidateSoon(be);
    be.audit(`schedule_remove_occurrence: ${weekday} ${timeKey} (${removed?.id})`);
    return removed;
  },
};

const updateStationMetaTool = {
  name: 'update_station_meta',
  description:
    'Edit station.json\'s station block and downtime window (the same write PUT /api/schedule/meta performs): station name, neverPlay keyword/artist bans (mirrored into filler.excludeKeywords on save), and the daily downtime window -- pass downtime null to clear it. Omitted keys are left unchanged. Returns the full station block and downtime after the merge.',
  inputSchema: {
    type: 'object',
    properties: {
      station: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          jingle: { type: 'string' },
          neverPlay: {
            type: 'object',
            properties: {
              keywords: { type: 'array', items: { type: 'string' } },
              artists: { type: 'array', items: { type: 'string' } },
            },
            additionalProperties: false,
          },
          filler: {
            type: 'object',
            properties: {
              excludeKeywords: { type: 'array', items: { type: 'string' } },
            },
            additionalProperties: false,
          },
        },
        additionalProperties: false,
      },
      downtime: {
        type: ['object', 'null'],
        properties: {
          start: { type: 'string', pattern: '^([01][0-9]|2[0-3]):[0-5][0-9]$' },
          end: { type: 'string', pattern: '^([01][0-9]|2[0-3]):[0-5][0-9]$' },
        },
        required: ['start', 'end'],
        additionalProperties: false,
      },
    },
    additionalProperties: false,
  },
  write: true,
  handler: async (args) => {
    const be = await loadBackend();
    // studioScheduleApi.js:105-113 route composition: the patch passes
    // through verbatim (request.body ?? {}, :107). The writer's own comment
    // documents the accepted set as "name/downtime/neverPlay/
    // filler.excludeKeywords" (stationWriter.js:253) -- downtime is top-level
    // (:263), neverPlay sits under station (:257-262), arrays are replaced
    // wholesale, downtime:null clears, omitting leaves. The route/writer
    // perform NO validation and the tool invents none either -- the HH:MM
    // patterns above are client-side documentation of the documented
    // contract (scheduleUtil.js:97-99).
    let result;
    try {
      result = await be.updateStationMeta(args ?? {});
    } catch (err) {
      throw new ToolFailure(err.message);
    }
    invalidateSoon(be);
    be.audit(
      `update_station_meta: ${Object.keys(args?.station ?? {}).join(',') || '-'}${
        args?.downtime !== undefined ? ' +downtime' : ''
      }`
    );
    return result; // { station, downtime } -- the route's exact body (:109)
  },
};

export const TOOLS = [
  nowPlayingTool,
  playHistoryTool,
  upcomingShowsTool,
  weeklyScheduleTool,
  listShowsTool,
  showDetailTool,
  requestsListTool,
  requestGetTool,
  pollsActiveTool,
  pollsHistoryTool,
  listenerStatsTool,
  librarySearchTool,
  trackMetadataTool,
  imagingInventoryTool,
  voiceDropsTool,
  stationIdentityTool,
  componentHealthTool,
  requestAddTool,
  requestModerateTool,
  requestQueueTool,
  pollCreateTool,
  pollVoteTool,
  pollCloseTool,
  skipTrackTool,
  forceNextShowTool,
  scheduleAddOccurrenceTool,
  scheduleUpdateOccurrenceTool,
  scheduleRemoveOccurrenceTool,
  updateStationMetaTool,
];

export function toolByName(name) {
  return TOOLS.find((tool) => tool.name === name) ?? null;
}
