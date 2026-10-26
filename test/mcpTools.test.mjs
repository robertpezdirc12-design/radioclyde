// Tool-layer tests for the MCP server (src/mcp/tools.js): REAL handlers
// against the fixture dataDir (setupTestConfig), with the network-touching
// seams (probeIcecast / sendCommand / fetchAllTracks) replaced by injected
// fakes -- the injectable-core discipline the rest of the suite already
// follows. Store-level honesty (polls/requests lifecycles, atomic writes) is
// pinned by polls.test.mjs / requestsStore.test.mjs; these tests pin the
// MCP layer ON TOP of the same stores: honest empties, business failures as
// thrown ToolFailure messages, provenance (ip 'mcp'), and the
// allowWriteTools kill-switch.
//
// One exception to the injected-fakes rule, honest and loopback-only: the
// request_queue happy path below exercises the REAL telnetClient (the ctx
// seam cannot reach queueRequest's statically imported telnet call) against
// a fake Liquidsoap speaking the real wire protocol on 127.0.0.1 -- the
// requestQueue.test.mjs:114-127 pattern; no external network is touched.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { setupTestConfig, repoRoot, writeWav, ratingKeyForFile } from './fixtures.mjs';

const REPO = repoRoot();
const DATA_DIR = path.join(REPO, 'data', 'test-mcp-tools');
const MUSIC_DIR = path.join(DATA_DIR, 'music');

setupTestConfig('mcp-tools', {
  // A real one-file local library: the wav fixture has readable (empty)
  // tags, so localLibrary derives artist/title from the "Artist - Title"
  // filename and the track_metadata / library_search tools get REAL data
  // with zero network and zero Plex.
  autoRadio: {
    enabled: true,
    stationName: 'Test Station',
    music: { source: 'local', localDirs: [MUSIC_DIR] },
    rules: { artistCooldownHours: 3 },
    voice: { mode: 'none' },
  },
});

const { TOOLS, toolByName } = await import('../src/mcp/tools.js');
const { createMcpServer } = await import('../src/mcp/protocol.js');
const pollsStore = await import('../src/server/pollsStore.js');
const requestsStore = await import('../src/server/requestsStore.js');
const { lookupRatingKey } = await import('../src/plex/ratingKeyIndex.js');
const { config } = await import('../src/config/index.js');

const WAV = path.join(MUSIC_DIR, 'Ansambel Markec - Testna Pesem.wav');
fs.mkdirSync(MUSIC_DIR, { recursive: true });
writeWav(WAV, 2);

function tool(name) {
  const t = toolByName(name);
  assert.ok(t, `tool "${name}" exists in the catalog`);
  return t;
}

function noTmpLeftovers() {
  const found = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (/\.tmp/.test(entry.name)) found.push(full);
      if (entry.isDirectory()) walk(full);
    }
  };
  walk(DATA_DIR);
  return found;
}

describe('catalog shape', () => {
  test('30 tools: 17 read + 13 write, unique names, object schemas', () => {
    assert.equal(TOOLS.length, 30);
    assert.equal(TOOLS.filter((t) => t.write).length, 13);
    assert.equal(new Set(TOOLS.map((t) => t.name)).size, 30);
    for (const t of TOOLS) {
      assert.equal(typeof t.name, 'string');
      assert.equal(typeof t.description, 'string');
      assert.equal(t.inputSchema.type, 'object');
      assert.equal(typeof t.handler, 'function');
    }
  });

  test('every tool name uses snake_case with no MCP-reserved prefixes', () => {
    for (const t of TOOLS) assert.match(t.name, /^[a-z][a-z0-9_]*$/);
  });
});

describe('read tools: honest empties on a fresh dataDir', () => {
  test('now_playing -> no show, no track, station block present', async () => {
    const res = await tool('now_playing').handler({}, {});
    assert.equal(res.show, null);
    assert.equal(res.track, null);
    assert.equal(res.dj, null);
    assert.equal(res.station.name, 'Test Station');
    assert.ok(Array.isArray(res.station.streams));
  });

  test('play_history / upcoming_shows / requests_list / polls_active / list_shows all empty', async () => {
    assert.deepEqual((await tool('play_history').handler({}, {})).entries, []);
    assert.deepEqual((await tool('upcoming_shows').handler({}, {})).shows, []);
    assert.deepEqual((await tool('requests_list').handler({}, {})).requests, []);
    assert.equal((await tool('polls_active').handler({}, {})).poll, null);
    assert.deepEqual((await tool('list_shows').handler({}, {})).shows, []);
  });

  test('weekly_schedule: 7 empty days from an empty station.json, downtime null', async () => {
    const res = await tool('weekly_schedule').handler({}, {});
    assert.equal(res.days.length, 7);
    for (const day of res.days) assert.deepEqual(day.shows, []);
    assert.equal(res.downtime, null);
    assert.equal(res.currentShow, null);
  });

  test('station_identity: name, derived stream URL, playlist bodies, ports', async () => {
    const res = await tool('station_identity').handler({}, {});
    assert.equal(res.name, 'Test Station');
    assert.equal(res.streamUrl, 'http://localhost:3999/stream');
    assert.equal(res.streams[0].format, 'mp3');
    assert.match(res.listenM3u, /^#EXTM3U\n/);
    assert.match(res.listenPls, /^\[playlist\]/);
    assert.deepEqual(res.icecast, { mount: '/stream', sourcePort: 8001 });
    assert.equal(res.webPort, 3999);
  });

  test('voice_drops: mode from config, djDropsGain defaults to 1', async () => {
    const res = await tool('voice_drops').handler({}, {});
    assert.equal(res.mode, 'none');
    assert.equal(res.djDropsGain, 1);
  });

  test('imaging_inventory: present dir counts clips, missing dir flagged honestly', async () => {
    const idDir = config.paths.imagingIdDir;
    fs.mkdirSync(idDir, { recursive: true });
    fs.writeFileSync(path.join(idDir, 'id-jutro.mp3'), 'x');
    const res = await tool('imaging_inventory').handler({}, {});
    assert.equal(res.layers.id.count, 1);
    assert.equal(res.layers.id.dirMissing, false);
    assert.equal(res.layers.id.tag, 'id');
    assert.equal(res.layers.stingers.dirMissing, true);
    assert.equal(res.layers.emergency.dirMissing, true);
    // Paket B2: the promo layer rides the same inventory (generated and
    // operator clips are indistinguishable here -- read-only either way).
    assert.equal(res.layers.promos.dirMissing, true);
    assert.equal(res.layers.promos.tag, 'promo');
    // read-only: no .m3u was written for any layer
    assert.ok(!fs.existsSync(config.paths.imagingIdPath));
    assert.ok(!fs.existsSync(config.paths.imagingPromosPath));
  });
});

describe('listener_stats (probeIcecast injected)', () => {
  test('dead Icecast: honest result with the error text, listeners null, peak from the ledger', async () => {
    fs.mkdirSync(path.dirname(config.paths.listenerSamplesFile), { recursive: true });
    fs.appendFileSync(
      config.paths.listenerSamplesFile,
      JSON.stringify({ ts: new Date(Date.now() - 60_000).toISOString(), listeners: 3 }) + '\n'
    );
    const probe = async () => ({ reachable: false, healthy: false, listeners: null, error: 'connect ECONNREFUSED' });
    const res = await tool('listener_stats').handler({}, { probeIcecast: probe });
    assert.equal(res.listeners, null);
    assert.equal(res.peak, 3);
    assert.equal(res.icecast.error, 'connect ECONNREFUSED');
  });

  test('healthy Icecast: listener count surfaces, empty ledger -> peak null', async () => {
    // The previous test left a valid sample in the ledger -- a fresh install
    // (no ledger at all) is the honest "peak null" case, so drop it here.
    fs.rmSync(config.paths.listenerSamplesFile, { force: true });
    const probe = async () => ({ reachable: true, healthy: true, status: 200, listeners: 5, mountCount: 1 });
    const res = await tool('listener_stats').handler({}, { probeIcecast: probe });
    assert.equal(res.listeners, 5);
    assert.equal(res.peak, null, 'no ledger at all yet -- the truthful null peak');
  });
});

describe('component_health (probeIcecast injected)', () => {
  test('full snapshot with honest empties; include_logs:false skips log tails', async () => {
    const probe = async () => ({ reachable: false, healthy: false, listeners: null, error: 'down' });
    const res = await tool('component_health').handler({ include_logs: false }, { probeIcecast: probe });
    assert.equal(res.stream.icecast.error, 'down');
    assert.equal(res.playlists.nowPlaying.exists, false);
    assert.equal(res.deadAir.exists, false);
    assert.deepEqual(res.repeats.offenders, []);
    assert.deepEqual(res.logs, {});
    assert.equal(typeof res.generatedAt, 'string');
  });

  test('log tails included by default and only for the three station logs', async () => {
    fs.mkdirSync(config.paths.logsDir, { recursive: true });
    fs.writeFileSync(path.join(config.paths.logsDir, 'web.log'), 'vrstica 1\nvrstica 2\n');
    fs.writeFileSync(path.join(config.paths.logsDir, 'other.log'), 'ne pokaži me\n');
    const probe = async () => ({ reachable: true, healthy: true, listeners: 0, mountCount: 0 });
    const res = await tool('component_health').handler({}, { probeIcecast: probe });
    assert.deepEqual(res.logs['web.log'], ['vrstica 1', 'vrstica 2']);
    assert.equal(res.logs['other.log'], undefined);
    assert.equal(res.logs['station.log'], undefined, 'missing logs are simply absent');
  });
});

describe('library_search (fetchAllTracks injected + real local library)', () => {
  const fakeTracks = [
    { ratingKey: 'rk1', artist: 'Ana Pop', title: 'Sreča', album: 'Album A', genre: ['rock'], durationMs: 200_000 },
    { ratingKey: 'rk2', artist: 'Miha Rock', title: 'Kamen', album: 'Album B', genre: [], durationMs: 180_000 },
    { ratingKey: 'rk3', artist: 'Ana Pop', title: 'Kamen', album: null, genre: ['folk'], durationMs: 0 },
  ];

  test('case-insensitive substring over artist/title/album, limit applied, counts honest', async () => {
    let calls = 0;
    const fake = async () => {
      calls += 1;
      return fakeTracks;
    };
    const res = await tool('library_search').handler({ query: 'ana', limit: 1 }, { fetchAllTracks: fake });
    assert.equal(res.total, 3);
    assert.equal(res.filteredTotal, 2, 'artist match + title/album case-insensitive');
    assert.equal(res.tracks.length, 1, 'limit honored');
    assert.equal(res.tracks[0].artist, 'Ana Pop');
    assert.equal(calls, 1);
  });

  test('the 60 s snapshot cache rides the same injected fetch (one scan per TTL window)', async () => {
    let calls = 0;
    const fake = async () => {
      calls += 1;
      return fakeTracks;
    };
    await tool('library_search').handler({ query: 'x' }, { fetchAllTracks: fake });
    await tool('library_search').handler({ query: 'y' }, { fetchAllTracks: fake });
    assert.equal(calls, 1, 'second query within TTL reused the snapshot');
    let otherCalls = 0;
    const otherFake = async () => {
      otherCalls += 1;
      return [];
    };
    const res = await tool('library_search').handler({ query: 'z' }, { fetchAllTracks: otherFake });
    assert.equal(res.total, 0);
    assert.equal(otherCalls, 1, 'a different fetch function is a different cache key');
  });

  test('against the REAL local library (source local, one wav): search finds the fixture track', async () => {
    const res = await tool('library_search').handler({ query: 'testna' }, {});
    assert.equal(res.total, 1);
    assert.equal(res.filteredTotal, 1);
    assert.equal(res.tracks[0].artist, 'Ansambel Markec');
    assert.equal(res.tracks[0].title, 'Testna Pesem');
    assert.equal(res.tracks[0].ratingKey, ratingKeyForFile(WAV));
  });

  test('empty query is refused honestly', async () => {
    await assert.rejects(tool('library_search').handler({ query: '   ' }, {}), /Manjka iskalni niz/);
  });
});

describe('track_metadata (local source, real library)', () => {
  test('by rating_key and by local_path both resolve the same real track', async () => {
    const byKey = await tool('track_metadata').handler({ rating_key: ratingKeyForFile(WAV) }, {});
    assert.equal(byKey.source, 'local');
    assert.equal(byKey.track.localPath, WAV);
    const byPath = await tool('track_metadata').handler({ local_path: WAV }, {});
    assert.equal(byPath.source, 'local');
    assert.equal(byPath.track.ratingKey, ratingKeyForFile(WAV));
  });

  test('exactly-one-of validation and honest not-found', async () => {
    await assert.rejects(
      tool('track_metadata').handler({ rating_key: 'a', local_path: 'b' }, {}),
      /ne oboje hkrati/
    );
    await assert.rejects(tool('track_metadata').handler({}, {}), /Podaj rating_key ali local_path/);
    await assert.rejects(
      tool('track_metadata').handler({ rating_key: 'nope' }, {}),
      /ni v lokalni knjižnici/
    );
  });
});

describe('show_detail / list_shows against real briefs', () => {
  test('a written brief lists and round-trips; unknown/invalid ids fail honestly', async () => {
    const dir = config.paths.showDescriptionsDir;
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'rock-vecer.md'),
      '# Rock Večer\n**Personas:** markec, vesna\n**Segments:** quiz, weather\n\n## Description\n\nProsti tekst.\n'
    );
    const list = await tool('list_shows').handler({}, {});
    assert.equal(list.shows.length, 1);
    assert.equal(list.shows[0].id, 'rock-vecer');
    assert.deepEqual(list.shows[0].personas, ['markec', 'vesna']);

    const detail = await tool('show_detail').handler({ id: 'rock-vecer' }, {});
    assert.equal(detail.title, 'Rock Večer');
    assert.equal(detail.description, 'Prosti tekst.');

    await assert.rejects(tool('show_detail').handler({ id: 'ne-obstaja' }, {}), /No show "ne-obstaja" found/);
    await assert.rejects(tool('show_detail').handler({ id: '../evil' }, {}), /Invalid show id/);
    await assert.rejects(tool('show_detail').handler({}, {}), /Manjka "id"/);
  });
});

describe('request_add / request_moderate / request_queue', () => {
  test('validation errors refuse AND write nothing; a valid request lands pending with ip "mcp"', async () => {
    await assert.rejects(tool('request_add').handler({ type: 'request', title: '' }, {}), /naslov pesmi/);
    await assert.rejects(
      tool('request_add').handler({ type: 'dedication', message: '' }, {}),
      /Posvetilo brez sporočila/
    );
    assert.equal(requestsStore.readRequests().length, 0, 'refused submissions write nothing');

    const res = await tool('request_add').handler(
      { type: 'request', title: 'Pesem', artist: 'Izvajalec', from: 'Ana' },
      { now: 1000 }
    );
    assert.equal(res.status, 'pending');
    assert.equal(res.ip, undefined, 'publicView projection, like the route');
    const stored = requestsStore.getRequest(res.id);
    assert.equal(stored.ip, 'mcp', 'provenance for the moderation queue');
    assert.equal(stored.status, 'pending');
    assert.equal(stored.createdAt, new Date(1000).toISOString(), 'ctx.now freezes the clock');
  });

  test('approve -> reject with note persists atomically; pending is refused at the gate; unknown id honest', async () => {
    const added = await tool('request_add').handler({ type: 'request', title: 'Druga' }, {});
    const approved = await tool('request_moderate').handler({ id: added.id, status: 'approved' }, {});
    assert.equal(approved.status, 'approved');
    const rejected = await tool('request_moderate').handler(
      { id: added.id, status: 'rejected', note: 'Preveč zaigrano.' },
      {}
    );
    assert.equal(rejected.status, 'rejected');
    assert.equal(rejected.note, 'Preveč zaigrano.');
    assert.equal(requestsStore.getRequest(added.id).status, 'rejected');

    await assert.rejects(
      tool('request_moderate').handler({ id: added.id, status: 'pending' }, {}),
      /dovoljeno: approved, rejected/
    );
    await assert.rejects(tool('request_moderate').handler({ id: 'x', status: 'approved' }, {}), /ne obstaja/);
    await assert.rejects(tool('request_moderate').handler({ status: 'approved' }, {}), /Manjka "id"/);
  });

  test('request_queue on an unknown id never touches the network (honest refusal first)', async () => {
    await assert.rejects(tool('request_queue').handler({ id: 'ne-obstaja' }, {}), /Zahtevek ne obstaja/);
    await assert.rejects(tool('request_queue').handler({}, {}), /Manjka "id"/);
  });

  test('requests_list: status filter, invalid status refused, newest first', async () => {
    const res = await tool('requests_list').handler({ status: 'rejected' }, {});
    assert.ok(res.requests.every((r) => r.status === 'rejected'));
    await assert.rejects(tool('requests_list').handler({ status: 'shoutout' }, {}), /Neznan status/);
    const all = await tool('requests_list').handler({}, {});
    assert.equal(all.requests.length, 2);
  });
});

describe('poll lifecycle through the tool layer (frozen clock)', () => {
  const goodBody = { question: 'Kateri bend naj zaigra v soboto?', options: ['Pankrti', 'Buldožer', 'Štuk'] };

  test('create -> active; second create closes the first with the frozen closedAt', async () => {
    const first = await tool('poll_create').handler(goodBody, { now: 1000 });
    assert.equal(first.ok, true);
    assert.equal(pollsStore.readStore().active.id, first.poll.id);

    const second = await tool('poll_create').handler({ question: 'Naslednja?', options: ['x', 'y'] }, { now: 2000 });
    const after = pollsStore.readStore();
    assert.equal(after.active.id, second.poll.id);
    assert.equal(after.closed.length, 1);
    assert.equal(after.closed[0].closedAt, 2000);
  });

  test('votes accumulate via polls_active tallies; bad option / wrong id / closed are honest failures', async () => {
    const poll = await tool('poll_create').handler(goodBody, { now: 3000 });
    const vote1 = await tool('poll_vote').handler({ option: 1 }, { now: 3000 });
    assert.equal(vote1.ok, true);
    assert.deepEqual(vote1.tally, { total: 1, leader: 'Buldožer', leaderVotes: 1 });
    await tool('poll_vote').handler({ option: 1 }, {});
    await tool('poll_vote').handler({ option: 0 }, {});
    const active = await tool('polls_active').handler({}, {});
    assert.equal(active.poll.total, 3);
    assert.equal(active.poll.leader, 'Buldožer');
    assert.equal(active.poll.leaderVotes, 2);

    await assert.rejects(tool('poll_vote').handler({ option: 9 }, {}), /Neveljavna možnost/);
    await assert.rejects(tool('poll_vote').handler({ option: 0, id: 'poll-x' }, {}), /ni \(več\) aktivna/);
    await assert.rejects(tool('poll_vote').handler({}, {}), /Manjka ali neveljavna "option"/);
  });

  test('close freezes history; afterwards votes and closes fail honestly', async () => {
    const active = await tool('polls_active').handler({}, {});
    const closed = await tool('poll_close').handler({}, { now: 4000 });
    assert.equal(closed.ok, true);
    assert.equal((await tool('polls_active').handler({}, {})).poll, null);
    await assert.rejects(tool('poll_vote').handler({ option: 0 }, {}), /ni aktivne ankete/);
    await assert.rejects(tool('poll_close').handler({}, {}), /ni aktivne ankete/);

    const history = await tool('polls_history').handler({}, {});
    assert.ok(history.closed.length >= 3, 'every closed poll from this suite is frozen in history');
    assert.equal(history.closed[0].closedAt, 4000, 'newest first, frozen close timestamp');
  });

  test('poll_create validation surfaces the store\'s Slovenian errors', async () => {
    await assert.rejects(
      tool('poll_create').handler({ question: '', options: ['a', 'b'] }, {}),
      /brez vprašanja/
    );
    await assert.rejects(
      tool('poll_create').handler({ question: 'q', options: ['a'] }, {}),
      /2-6 možnosti/
    );
  });
});

describe('on-air controls (sendCommand injected)', () => {
  test('skip_track with a track on air sends the mount-derived skip command', async () => {
    fs.writeFileSync(
      config.paths.nowPlayingTrackPath,
      JSON.stringify({ artist: 'Ana Pop', title: 'Sreča', album: 'A', playedAt: new Date().toISOString() })
    );
    const sent = [];
    const send = async (command) => {
      sent.push(command);
      return 'END-ok';
    };
    const res = await tool('skip_track').handler({}, { sendCommand: send });
    assert.deepEqual(sent, ['/stream.skip'], 'skipCommandForMount(config.icecast.mount) — /stream mount');
    assert.deepEqual(res, { result: 'END-ok' });
  });

  test('skip_track with no track on air refuses honestly (no telnet call)', async () => {
    fs.rmSync(config.paths.nowPlayingTrackPath, { force: true });
    const sent = [];
    const send = async (c) => {
      sent.push(c);
      return 'x';
    };
    await assert.rejects(tool('skip_track').handler({}, { sendCommand: send }), /Nič za preskočiti/);
    assert.deepEqual(sent, []);
  });

  test('skip_track surfaces a telnet failure as an honest tool error', async () => {
    fs.writeFileSync(
      config.paths.nowPlayingTrackPath,
      JSON.stringify({ artist: 'A', title: 'T', playedAt: new Date().toISOString() })
    );
    const send = async () => {
      throw new Error('connection refused');
    };
    await assert.rejects(tool('skip_track').handler({}, { sendCommand: send }), /telnet ukaz ni uspel: connection refused/);
  });

  test('force_next_show on an unproduced lineup refuses before any telnet traffic', async () => {
    const sent = [];
    const send = async (c) => {
      sent.push(c);
      return 'x';
    };
    await assert.rejects(tool('force_next_show').handler({}, { sendCommand: send }), /No directed show/);
    assert.deepEqual(sent, []);
  });
});

// Placement note: these describes deliberately run AFTER the two above --
// they rewrite station.json (which the 'unproduced lineup' refusal and the
// read-tool empties depend on being schedule-less) and create
// now_playing_state.json / running/ artifacts nothing later reads. The
// no-.tmp-leftover sweep below still covers every write they perform.
describe('schedule & station-meta writes', () => {
  const stationFile = config.paths.stationFile;

  function writeBriefs() {
    const dir = config.paths.showDescriptionsDir;
    fs.mkdirSync(dir, { recursive: true });
    for (const id of ['jutranji', 'rock-vecer', 'vecerni']) {
      fs.writeFileSync(path.join(dir, `${id}.md`), `# ${id}\n\n## Description\n\nTestni povzetek.\n`);
    }
  }

  function writeStation(schedule) {
    fs.writeFileSync(stationFile, JSON.stringify({ station: { name: 'Test Station' }, schedule }, null, 2));
  }

  function readStation() {
    return JSON.parse(fs.readFileSync(stationFile, 'utf8'));
  }

  test('schedule_add_occurrence: happy add returns the whole day; a conflicting start repacks gapless', async () => {
    writeBriefs();
    writeStation({
      monday: [
        { id: 'jutranji', startTime: '08:00', durationMinutes: 60 },
        { id: 'rock-vecer', startTime: '09:00', durationMinutes: 60 },
      ],
    });
    // 08:30 collides with jutranji's 08:00-09:00 slot: insert + repack, never reject.
    const res = await tool('schedule_add_occurrence').handler(
      { weekday: 'monday', occurrence: { id: 'vecerni', startTime: '08:30', durationMinutes: 30 } },
      {}
    );
    assert.equal(res.weekday, 'monday');
    assert.deepEqual(res.occurrences, [
      { id: 'jutranji', startTime: '08:00', durationMinutes: 60 },
      { id: 'vecerni', startTime: '09:00', durationMinutes: 30 },
      { id: 'rock-vecer', startTime: '09:30', durationMinutes: 60 },
    ]);
    assert.deepEqual(readStation().schedule.monday, res.occurrences, 'persisted atomically');
    assert.ok(
      fs.existsSync(path.join(DATA_DIR, '.station_hash')),
      'invalidateSoon ran (the studioScheduleApi.js:27-33 mirror)'
    );
  });

  test('schedule_add_occurrence: writer validation passes through as ToolFailure (bad time, unknown show)', async () => {
    writeBriefs();
    writeStation({ monday: [{ id: 'jutranji', startTime: '08:00', durationMinutes: 60 }] });
    await assert.rejects(
      tool('schedule_add_occurrence').handler(
        { weekday: 'monday', occurrence: { id: 'vecerni', startTime: '25:00', durationMinutes: 30 } },
        {}
      ),
      /Invalid startTime "25:00" -- expected HH:MM/
    );
    await assert.rejects(
      tool('schedule_add_occurrence').handler(
        { weekday: 'monday', occurrence: { id: 'ne-obstaja', startTime: '22:00', durationMinutes: 30 } },
        {}
      ),
      /No show "ne-obstaja" found under show-descriptions/
    );
    assert.equal(readStation().schedule.monday.length, 1, 'refused writes change nothing');
  });

  test('schedule_add_occurrence: missing weekday is the handler-side requireString refusal', async () => {
    await assert.rejects(
      tool('schedule_add_occurrence').handler(
        { occurrence: { id: 'vecerni', startTime: '22:00', durationMinutes: 30 } },
        {}
      ),
      /Manjka "weekday"/
    );
  });

  test('schedule_update_occurrence: a resize repacks the day', async () => {
    writeBriefs();
    writeStation({
      monday: [
        { id: 'jutranji', startTime: '08:00', durationMinutes: 60 },
        { id: 'rock-vecer', startTime: '09:00', durationMinutes: 60 },
      ],
    });
    const res = await tool('schedule_update_occurrence').handler(
      { weekday: 'monday', time_key: '08-00', patch: { durationMinutes: 90 } },
      {}
    );
    assert.equal(res.weekday, 'monday');
    assert.deepEqual(res.occurrences, [
      { id: 'jutranji', startTime: '08:00', durationMinutes: 90 },
      { id: 'rock-vecer', startTime: '09:30', durationMinutes: 60 },
    ]);
  });

  test('schedule_update_occurrence: a plain move onto another slot swaps in place', async () => {
    writeBriefs();
    writeStation({
      monday: [
        { id: 'jutranji', startTime: '08:00', durationMinutes: 60 },
        { id: 'rock-vecer', startTime: '09:00', durationMinutes: 60 },
      ],
    });
    const res = await tool('schedule_update_occurrence').handler(
      { weekday: 'monday', time_key: '08-00', patch: { startTime: '09:00' } },
      {}
    );
    assert.deepEqual(res.occurrences, [
      { id: 'rock-vecer', startTime: '08:00', durationMinutes: 60 },
      { id: 'jutranji', startTime: '09:00', durationMinutes: 60 },
    ]);
  });

  test('schedule_update_occurrence: unknown time_key and missing time_key are honest refusals', async () => {
    writeBriefs();
    writeStation({ monday: [{ id: 'jutranji', startTime: '08:00', durationMinutes: 60 }] });
    await assert.rejects(
      tool('schedule_update_occurrence').handler(
        { weekday: 'monday', time_key: '07-07', patch: { durationMinutes: 30 } },
        {}
      ),
      /No occurrence at monday 07-07 to update/
    );
    await assert.rejects(
      tool('schedule_update_occurrence').handler({ weekday: 'monday', patch: { durationMinutes: 30 } }, {}),
      /Manjka "time_key"/
    );
  });

  test('schedule_remove_occurrence: returns the removed occurrence and closes the gap on disk', async () => {
    writeBriefs();
    writeStation({
      monday: [
        { id: 'jutranji', startTime: '08:00', durationMinutes: 60 },
        { id: 'rock-vecer', startTime: '09:00', durationMinutes: 60 },
        { id: 'vecerni', startTime: '10:00', durationMinutes: 30 },
      ],
    });
    const res = await tool('schedule_remove_occurrence').handler({ weekday: 'monday', time_key: '09-00' }, {});
    assert.deepEqual(res, { id: 'rock-vecer', startTime: '09:00', durationMinutes: 60 }, 'the route body is the removed occurrence itself');
    assert.deepEqual(readStation().schedule.monday, [
      { id: 'jutranji', startTime: '08:00', durationMinutes: 60 },
      { id: 'vecerni', startTime: '09:00', durationMinutes: 30 },
    ], 'the gap closed');
  });

  test('schedule_remove_occurrence: unknown time_key refuses honestly', async () => {
    writeBriefs();
    writeStation({ monday: [{ id: 'jutranji', startTime: '08:00', durationMinutes: 60 }] });
    await assert.rejects(
      tool('schedule_remove_occurrence').handler({ weekday: 'monday', time_key: '12-00' }, {}),
      /No occurrence at monday 12-00 to remove/
    );
  });

  // Paket C1/C2 (Val 22) -- schedule_set_date (the date-override write)
  // and the replay fields on add/update. Wall-clock-independent dates: a
  // past source is anchored well before any possible test run, a future one
  // well after (the writer's not-in-the-future check is a plain YYYY-MM-DD
  // string compare against the local calendar's dateKey).
  const PAST_SOURCE = '2020-06-15';
  const FUTURE_SOURCE = '2999-06-15';

  test('schedule_set_date: full-day override lands in schedule.dates, template untouched, audit + hash written', async () => {
    writeBriefs();
    writeStation({
      monday: [{ id: 'jutranji', startTime: '08:00', durationMinutes: 60 }],
    });
    fs.rmSync(path.join(DATA_DIR, '.station_hash'), { force: true });
    const res = await tool('schedule_set_date').handler(
      {
        date: '2026-12-25',
        occurrences: [
          { id: 'vecerni', startTime: '20:00', durationMinutes: 60 },
          { id: 'jutranji', startTime: '10:00', durationMinutes: 30 },
        ],
      },
      {}
    );
    // unordered input -> sorted, then packed back-to-back (the same
    // closeGaps discipline weekday writes follow); returned exactly as
    // written to disk.
    assert.equal(res.date, '2026-12-25');
    assert.deepEqual(res.occurrences, [
      { id: 'jutranji', startTime: '10:00', durationMinutes: 30 },
      { id: 'vecerni', startTime: '10:30', durationMinutes: 60 },
    ]);
    const raw = readStation();
    assert.deepEqual(raw.schedule.dates['2026-12-25'], res.occurrences, 'persisted atomically');
    assert.deepEqual(
      raw.schedule.monday,
      [{ id: 'jutranji', startTime: '08:00', durationMinutes: 60 }],
      'a date write never touches the weekly template'
    );
    assert.ok(
      fs.existsSync(path.join(DATA_DIR, '.station_hash')),
      'invalidateSoon ran (the studioScheduleApi.js:27-33 mirror)'
    );
    const mcpLog = fs.readFileSync(path.join(DATA_DIR, 'logs', 'mcp.log'), 'utf8');
    assert.ok(
      mcpLog.includes('schedule_set_date: 2026-12-25'),
      "the tool's own audit line landed in logs/mcp.log"
    );
  });

  test('schedule_set_date: an empty/omitted occurrences array is a deliberate dark day', async () => {
    writeBriefs();
    writeStation({ monday: [{ id: 'jutranji', startTime: '08:00', durationMinutes: 60 }] });
    const res = await tool('schedule_set_date').handler({ date: '2026-12-25' }, {});
    assert.deepEqual(res.occurrences, []);
    assert.deepEqual(
      readStation().schedule.dates['2026-12-25'],
      [],
      'the override is stored as an empty day -- it suppresses the template instead of falling back to it'
    );
  });

  test('schedule_set_date: clear removes the override (and the whole dates block with the last key)', async () => {
    writeBriefs();
    writeStation({ monday: [{ id: 'jutranji', startTime: '08:00', durationMinutes: 60 }] });
    await tool('schedule_set_date').handler(
      { date: '2026-12-25', occurrences: [{ id: 'vecerni', startTime: '20:00', durationMinutes: 60 }] },
      {}
    );
    const res = await tool('schedule_set_date').handler({ date: '2026-12-25', clear: true }, {});
    assert.equal(res.date, '2026-12-25');
    assert.equal(res.cleared, true);
    assert.equal(res.removed.length, 1);
    assert.equal(res.removed[0].id, 'vecerni');
    const raw = readStation();
    assert.equal(raw.schedule.dates, undefined, 'removing the last override key removes the whole dates block');
    assert.deepEqual(
      raw.schedule.monday,
      [{ id: 'jutranji', startTime: '08:00', durationMinutes: 60 }],
      'the weekly template is what the date falls back to'
    );
    // clearing something that is not there refuses honestly and changes nothing
    await assert.rejects(
      tool('schedule_set_date').handler({ date: '2026-12-25', clear: true }, {}),
      /No date override for "2026-12-25" to remove/
    );
    assert.equal(readStation().schedule.dates, undefined);
  });

  test('schedule_set_date: writer validation passes through as ToolFailure, station.json unchanged', async () => {
    writeBriefs();
    writeStation({ monday: [{ id: 'jutranji', startTime: '08:00', durationMinutes: 60 }] });
    const before = readStation();
    await assert.rejects(
      tool('schedule_set_date').handler({ date: '2026-13-45', occurrences: [] }, {}),
      /Invalid date "2026-13-45" -- not a real calendar date/
    );
    await assert.rejects(
      tool('schedule_set_date').handler({ date: 'not-a-date', occurrences: [] }, {}),
      /Invalid date "not-a-date" -- expected YYYY-MM-DD/
    );
    await assert.rejects(
      tool('schedule_set_date').handler(
        { date: '2026-12-25', occurrences: [{ id: 'ne-obstaja', startTime: '20:00', durationMinutes: 60 }] },
        {}
      ),
      /No show "ne-obstaja" found under show-descriptions/
    );
    await assert.rejects(
      tool('schedule_set_date').handler(
        {
          date: '2026-12-25',
          occurrences: [
            { id: 'vecerni', startTime: '20:00', durationMinutes: 60, type: 'replay', sourceDate: FUTURE_SOURCE },
          ],
        },
        {}
      ),
      new RegExp(`Replay sourceDate "${FUTURE_SOURCE}" is in the future`)
    );
    await assert.rejects(
      tool('schedule_set_date').handler(
        {
          date: '2026-12-25',
          occurrences: [{ id: 'vecerni', startTime: '20:00', durationMinutes: 60, type: 'maraton' }],
        },
        {}
      ),
      /Invalid occurrence type "maraton"/
    );
    await assert.rejects(
      tool('schedule_set_date').handler({ occurrences: [] }, {}),
      /Manjka "date"/
    );
    assert.deepEqual(readStation(), before, 'refused writes change nothing');
  });

  test('schedule_add_occurrence: replay fields land in station.json; a "normal" entry normalizes them away', async () => {
    writeBriefs();
    writeStation({ monday: [] });
    const res = await tool('schedule_add_occurrence').handler(
      {
        weekday: 'monday',
        occurrence: {
          id: 'vecerni',
          startTime: '20:00',
          durationMinutes: 60,
          type: 'replay',
          sourceDate: PAST_SOURCE,
          sourceTimeKey: '08-00',
        },
      },
      {}
    );
    assert.deepEqual(res.occurrences, [
      {
        id: 'vecerni',
        startTime: '20:00',
        durationMinutes: 60,
        type: 'replay',
        sourceDate: PAST_SOURCE,
        sourceTimeKey: '08-00',
      },
    ]);
    assert.deepEqual(readStation().schedule.monday, res.occurrences, 'the replay fields persisted on the entry');

    // "normal" (or an omitted type) must not carry stale replay metadata
    // into the file -- normalizeReplayFields strips it before storage.
    const plain = await tool('schedule_add_occurrence').handler(
      {
        weekday: 'monday',
        occurrence: { id: 'jutranji', startTime: '22:00', durationMinutes: 30, type: 'normal', sourceDate: PAST_SOURCE },
      },
      {}
    );
    assert.deepEqual(plain.occurrences[1], {
      id: 'jutranji',
      startTime: '21:00',
      durationMinutes: 30,
    });
  });

  test('schedule_update_occurrence: a patch accepts replay fields, and "type": "normal" clears them', async () => {
    writeBriefs();
    writeStation({ monday: [{ id: 'vecerni', startTime: '20:00', durationMinutes: 60 }] });
    const res = await tool('schedule_update_occurrence').handler(
      { weekday: 'monday', time_key: '20-00', patch: { type: 'replay', sourceDate: PAST_SOURCE, sourceTimeKey: '08-00' } },
      {}
    );
    assert.deepEqual(res.occurrences, [
      {
        id: 'vecerni',
        startTime: '20:00',
        durationMinutes: 60,
        type: 'replay',
        sourceDate: PAST_SOURCE,
        sourceTimeKey: '08-00',
      },
    ]);
    assert.deepEqual(readStation().schedule.monday, res.occurrences, "the patch's replay fields persisted");

    const cleared = await tool('schedule_update_occurrence').handler(
      { weekday: 'monday', time_key: '20-00', patch: { type: 'normal' } },
      {}
    );
    assert.deepEqual(cleared.occurrences, [
      { id: 'vecerni', startTime: '20:00', durationMinutes: 60 },
    ], '"type": "normal" strips the replay fields from the stored entry');
    assert.deepEqual(readStation().schedule.monday, cleared.occurrences);
  });

  test('update_station_meta: name change + downtime set, omitted keys untouched', async () => {
    writeBriefs();
    fs.writeFileSync(
      stationFile,
      JSON.stringify(
        {
          station: { name: 'Test Station', filler: { excludeKeywords: ['stari'] } },
          downtime: { start: '02:00', end: '05:00' },
          schedule: { monday: [{ id: 'jutranji', startTime: '08:00', durationMinutes: 60 }] },
        },
        null,
        2
      )
    );
    const res = await tool('update_station_meta').handler(
      { station: { name: 'Radio Markec 2' }, downtime: { start: '01:00', end: '06:00' } },
      {}
    );
    assert.equal(res.station.name, 'Radio Markec 2');
    assert.deepEqual(res.downtime, { start: '01:00', end: '06:00' });
    assert.deepEqual(res.station.filler.excludeKeywords, ['stari'], 'omitted keys are left unchanged');
    const raw = readStation();
    assert.equal(raw.station.name, 'Radio Markec 2');
    assert.deepEqual(raw.downtime, { start: '01:00', end: '06:00' });
  });

  test('update_station_meta: neverPlay replaces wholesale and syncs filler.excludeKeywords', async () => {
    writeBriefs();
    fs.writeFileSync(
      stationFile,
      JSON.stringify(
        {
          station: {
            name: 'Test Station',
            neverPlay: { keywords: ['prvi'], artists: [] },
            filler: { excludeKeywords: ['prvi'] },
          },
          schedule: {},
        },
        null,
        2
      )
    );
    const res = await tool('update_station_meta').handler(
      { station: { neverPlay: { keywords: ['novomesto', 'dežela'], artists: ['Nekdo Slaven'] } } },
      {}
    );
    assert.deepEqual(res.station.neverPlay, { keywords: ['novomesto', 'dežela'], artists: ['Nekdo Slaven'] });
    assert.deepEqual(
      res.station.filler.excludeKeywords,
      ['novomesto', 'dežela'],
      'neverPlay.keywords mirrors into filler.excludeKeywords (stationWriter.js:257-262)'
    );
  });

  test('update_station_meta: downtime null clears the window; an omitted station block is untouched', async () => {
    writeBriefs();
    fs.writeFileSync(
      stationFile,
      JSON.stringify({ station: { name: 'Test Station' }, downtime: { start: '02:00', end: '05:00' }, schedule: {} }, null, 2)
    );
    const res = await tool('update_station_meta').handler({ downtime: null }, {});
    assert.equal(res.downtime, null);
    assert.equal(res.station.name, 'Test Station');
    assert.equal(readStation().downtime, null);
  });

  test('a shared weekday key splits into plain per-weekday keys on write', async () => {
    writeBriefs();
    fs.writeFileSync(
      stationFile,
      JSON.stringify(
        {
          station: { name: 'Test Station' },
          schedule: { 'monday,tuesday': [{ id: 'jutranji', startTime: '08:00', durationMinutes: 60 }] },
        },
        null,
        2
      )
    );
    const res = await tool('schedule_add_occurrence').handler(
      { weekday: 'monday', occurrence: { id: 'rock-vecer', startTime: '09:00', durationMinutes: 60 } },
      {}
    );
    assert.equal(res.occurrences.length, 2);
    const raw = readStation();
    assert.deepEqual(
      Object.keys(raw.schedule).sort(),
      ['monday', 'tuesday'],
      'comma-joined compression never survives a write (stationWriter.js:141-149)'
    );
    assert.equal(raw.schedule.monday.length, 2);
    assert.equal(raw.schedule.tuesday.length, 1, 'the untouched day keeps the shared lineup verbatim');
  });
});

describe('force_next_show happy path (directed occurrence fixture)', () => {
  const FIXTURE_DATE = '2026-10-19'; // arbitrary valid dateKey; the weekday comes from the schedule keys, not this date

  // State-driven and wall-clock-independent (updateNowPlaying.js:218-250):
  // a stale state pointing at the FIRST monday show makes the 40-walk purely
  // schedule-driven, so the result never depends on what day it really is.
  function prepareForceNextFixture() {
    // 1) two-show monday lineup (replaces the schedule-less station.json)
    fs.writeFileSync(
      config.paths.stationFile,
      JSON.stringify(
        {
          station: { name: 'Test Station' },
          schedule: {
            monday: [
              { id: 'jutranji', startTime: '08:00', durationMinutes: 60 },
              { id: 'rock-vecer', startTime: '09:00', durationMinutes: 60 },
            ],
          },
        },
        null,
        2
      )
    );
    // 2) stale state pointing at the FIRST show (the current one, per
    // currentShowEntry -- updateNowPlaying.js:122-126)
    fs.writeFileSync(
      config.paths.nowPlayingStatePath,
      JSON.stringify({
        weekday: 'monday',
        id: 'jutranji',
        date: FIXTURE_DATE,
        timeKey: '08-00',
        estimatedEndAt: 1,
        confirmed: true,
      })
    );
    // 3) directed occurrence dir for the SECOND show (playlist.m3u +
    // context.json -- isDirected, updateNowPlaying.js:128-133). No brief
    // files needed: nothing on this path reads show-descriptions.
    const occDir = path.join(config.paths.runningDir, 'monday', 'rock-vecer', FIXTURE_DATE, '09-00');
    fs.mkdirSync(occDir, { recursive: true });
    fs.writeFileSync(path.join(occDir, 'playlist.m3u'), `${WAV}\n`);
    fs.writeFileSync(path.join(occDir, 'context.json'), JSON.stringify({ durationSeconds: 3600 }));
  }

  test('loads the next directed occurrence, then reloads and skips', async () => {
    prepareForceNextFixture();
    const sent = [];
    const send = async (command) => {
      sent.push(command);
      return 'ok';
    };
    const res = await tool('force_next_show').handler({}, { sendCommand: send });
    assert.deepEqual(sent, ['show_source.reload', '/stream.skip'], 'route order: studioOnAirApi.js:81-87');
    assert.equal(res.state.id, 'rock-vecer');
    assert.equal(res.state.weekday, 'monday');
    assert.equal(res.state.date, FIXTURE_DATE);
    assert.equal(res.state.timeKey, '09-00');
    assert.equal(res.state.confirmed, false);
    assert.ok(res.state.estimatedEndAt > Date.now(), 'durationSeconds 3600 from context.json');
    assert.equal(fs.readFileSync(config.paths.nowPlayingPath, 'utf8'), `${WAV}\n`, 'now_playing.m3u carries the raw playlist');
  });

  test('a skip failure after a successful load surfaces the telnet error (the load already happened)', async () => {
    prepareForceNextFixture();
    let calls = 0;
    const send = async () => {
      calls += 1;
      if (calls === 1) return 'ok'; // show_source.reload (best-effort)
      throw new Error('connection reset'); // the mandatory skip
    };
    await assert.rejects(
      tool('force_next_show').handler({}, { sendCommand: send }),
      /telnet ukaz ni uspel: connection reset/
    );
    assert.equal(fs.readFileSync(config.paths.nowPlayingPath, 'utf8'), `${WAV}\n`, 'the switch itself already landed');
  });
});

describe('request_queue happy path (fake Liquidsoap telnet on loopback)', () => {
  // copy of requestQueue.test.mjs:114-127 -- the real wire protocol
  // (command -> <reply>\nEND\n). The tool handler does NOT route through
  // ctx.sendCommand (queueRequest statically imports telnetClient), so the
  // happy path has to speak real TCP to a loopback fake and point the LIVE
  // config object's telnetPort at it -- telnetClient reads host/port at call
  // time (telnetClient.js:27-30).
  function startFakeLiquidsoap(responder) {
    return new Promise((resolve) => {
      const server = net.createServer((socket) => {
        socket.on('data', (chunk) => {
          for (const cmd of chunk.toString('utf8').split('\n')) {
            const line = cmd.trim();
            if (!line || line === 'quit') continue;
            socket.write(`${responder(line)}\nEND\n`);
          }
        });
      });
      server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
    });
  }

  test('approved request, real local library, fake telnet: queued, noted, scrobble-registered', async () => {
    const added = await tool('request_add').handler(
      { type: 'request', title: 'Testna Pesem', artist: 'Ansambel Markec', from: 'Ana' },
      {}
    );
    await tool('request_moderate').handler({ id: added.id, status: 'approved' }, {});

    let seen = null;
    const fake = await startFakeLiquidsoap((cmd) => {
      seen = cmd;
      return cmd.startsWith('requests.push ') ? '42' : 'ERROR: unknown command';
    });
    const prevPort = config.liquidsoap.telnetPort;
    config.liquidsoap.telnetPort = fake.port; // live config object -> telnetClient reads it per call
    try {
      const res = await tool('request_queue').handler({ id: added.id }, {});
      assert.equal(res.ok, true);
      assert.equal(res.requestId, '42');
      assert.deepEqual(res.track, { artist: 'Ansambel Markec', title: 'Testna Pesem' });
      assert.equal(seen, `requests.push ${WAV}`);
      const stored = requestsStore.getRequest(added.id);
      assert.equal(stored.status, 'approved', 'queueing never implies moderation');
      assert.match(stored.note, /predvajalni vrsti/);
      assert.match(stored.note, /#42/);
      assert.equal(lookupRatingKey(WAV), ratingKeyForFile(WAV), 'scrobble index registered');
    } finally {
      config.liquidsoap.telnetPort = prevPort;
      fake.server.close();
    }
  });
});

describe('atomic writes: no .tmp leftovers anywhere under dataDir', () => {
  test('polls.json, requests.jsonl and friends leave no tmp files behind', () => {
    assert.deepEqual(noTmpLeftovers(), []);
  });
});

describe('allowWriteTools kill-switch (protocol-level, real TOOLS)', () => {
  test('tools/list omits every write tool; calling one answers isError naming the switch', async () => {
    const server = createMcpServer({ tools: TOOLS, allowWriteTools: false });
    const list = JSON.parse(await server.handleLine(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' })));
    const names = list.result.tools.map((t) => t.name);
    assert.equal(names.length, 17);
    for (const t of TOOLS.filter((x) => x.write)) assert.ok(!names.includes(t.name), `${t.name} omitted`);
    // Paket C (Val 22): the newest write tool hides with the rest -- pinned
    // explicitly so a future catalog regression cannot hide behind the
    // loop's genericity.
    assert.ok(!names.includes('schedule_set_date'));

    const call = JSON.parse(
      await server.handleLine(
        JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'request_add', arguments: { title: 'X' } } })
      )
    );
    assert.equal(call.result.isError, true);
    assert.match(call.result.content[0].text, /allowWriteTools/);

    const read = JSON.parse(
      await server.handleLine(
        JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'polls_active' } })
      )
    );
    assert.notEqual(read.result.isError, true, 'read tools unaffected');

    // A direct call of the newest write tool is refused with the same
    // kill-switch isError -- protocol.js refuses BEFORE any handler (and
    // any config/dataDir touch) runs.
    const setDate = JSON.parse(
      await server.handleLine(
        JSON.stringify({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'schedule_set_date', arguments: { date: '2026-12-25' } } })
      )
    );
    assert.equal(setDate.result.isError, true);
    assert.match(setDate.result.content[0].text, /allowWriteTools/);
  });
});
