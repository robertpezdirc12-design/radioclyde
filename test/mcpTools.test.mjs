// Tool-layer tests for the MCP server (src/mcp/tools.js): REAL handlers
// against the fixture dataDir (setupTestConfig), with the network-touching
// seams (probeIcecast / sendCommand / fetchAllTracks) replaced by injected
// fakes -- the injectable-core discipline the rest of the suite already
// follows. Store-level honesty (polls/requests lifecycles, atomic writes) is
// pinned by polls.test.mjs / requestsStore.test.mjs; these tests pin the
// MCP layer ON TOP of the same stores: honest empties, business failures as
// thrown ToolFailure messages, provenance (ip 'mcp'), and the
// allowWriteTools kill-switch.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
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
  test('25 tools: 17 read + 8 write, unique names, object schemas', () => {
    assert.equal(TOOLS.length, 25);
    assert.equal(TOOLS.filter((t) => t.write).length, 8);
    assert.equal(new Set(TOOLS.map((t) => t.name)).size, 25);
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
    // read-only: no .m3u was written for any layer
    assert.ok(!fs.existsSync(config.paths.imagingIdPath));
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
  });
});
