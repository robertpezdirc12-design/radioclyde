// Deployment-parity structural regression (Val 34, "namestitev dobi
// referenčni grafi predvajanja"): Liquidsoap can't run in CI, so (same
// pattern as radioLiqImaging.test.mjs / radioLiqIcy.test.mjs /
// clockwheel.test.mjs) this test scans SOURCES and pins the wiring the
// deployment depends on.
//
// The Val 34 decision it guards: deploy/ubuntu/install.sh no longer writes
// its own simplified radio.liq template -- the systemd unit runs the app
// tree's REFERENCE graph in place:
//   ExecStart=/usr/bin/liquidsoap /opt/radioclyde/app/liquidsoap/radio.liq
//   Environment=RADIOCLYDE_HOME=/opt/radioclyde/app
// Why this is load-bearing:
//   - the template lacked the request queue, the imaging layers, the
//     measured transitions and the optional mounts -- every DEPLOYMENT_GUIDE
//     "known limitation" paragraph existed only because of it;
//   - running in place means %include "streams.liq" resolves where
//     src/liquidsoap/streamsLiqWriter.js regenerates it at every web boot
//     (a config/ copy would go silently stale) and a code update IS the
//     engine update;
//   - RADIOCLYDE_HOME keeps config.json + helper spawns resolvable without
//     editing the file (docs/liquidsoap-upgrade.md's "Namestitvena pot").
// The live half of the proof (2026-10-28, official 2.2.4 binary via the
// .liq-bin matrix, fake Icecast, Goertzel on the captured stream):
// --check clean on both binaries, boot tolerant of a dataDir with nothing
// but filler.m3u, 128 kbps streaming from config.json values, telnet up,
// and a pushed request airing for exactly its 10 s. This file pins the
// paperwork so the decision cannot silently regress.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

import { repoRoot } from './fixtures.mjs';

// Same stripping as radioLiqIcy.test.mjs: shell # comments and Liquidsoap #
// comments go the same way, and install.sh's heredocs are single-quoted, so
// nothing is shell-expanded -- every assertion runs against code only.
const stripComments = (raw) =>
  raw
    .split('\n')
    .map((line) => line.replace(/#.*$/, ''))
    .join('\n');

const installSh = stripComments(
  fs.readFileSync(path.join(repoRoot(), 'deploy', 'ubuntu', 'install.sh'), 'utf8')
);
const installShRaw = fs.readFileSync(path.join(repoRoot(), 'deploy', 'ubuntu', 'install.sh'), 'utf8');
const guide = fs.readFileSync(path.join(repoRoot(), 'deploy', 'ubuntu', 'DEPLOYMENT_GUIDE.md'), 'utf8');
const runbook = fs.readFileSync(path.join(repoRoot(), 'docs', 'liquidsoap-upgrade.md'), 'utf8');
const liq = stripComments(
  fs.readFileSync(path.join(repoRoot(), 'liquidsoap', 'radio.liq'), 'utf8')
);

describe('deployment runs the reference playout graph (Val 34)', () => {
  test('the liquidsoap unit starts the app tree reference with RADIOCLYDE_HOME', () => {
    assert.match(
      installSh,
      /ExecStart=\/usr\/bin\/liquidsoap \/opt\/radioclyde\/app\/liquidsoap\/radio\.liq/
    );
    assert.match(installSh, /Environment=RADIOCLYDE_HOME=\/opt\/radioclyde\/app/);
  });

  test('no radio.liq heredoc template anymore (one file, one truth)', () => {
    // The whole Val 34 point: the template's heredoc is GONE. Anyone
    // reintroducing a second graph must re-read the guide's limitation
    // history first. Raw read here -- LIQ_EOF is a heredoc marker, not a
    // comment, so stripping is not enough for this antipin.
    assert.doesNotMatch(installShRaw, /LIQ_EOF/);
    assert.doesNotMatch(installShRaw, /write_radio_liq/);
    assert.doesNotMatch(installSh, /output\.icecast\(/);
    assert.doesNotMatch(installSh, /show_source = playlist\(/);
  });

  test('install.sh warns loudly when the app tree is not uploaded yet', () => {
    // The unit points at the app tree on purpose; a fresh box that runs the
    // installer BEFORE uploading code (guide Korak 3.1 -> 3.2 order) must be
    // told so, not silently left with a dead ExecStart.
    assert.match(installSh, /App code not uploaded yet/);
    assert.match(installSh, /guide Korak 3\.2/);
  });

  test('the reference graph carries every feature the guide promises deployments', () => {
    // Cross-file honesty pin: DEPLOYMENT_GUIDE tells operators wishes air,
    // imaging layers exist, beds exist -- the file the unit runs must
    // actually carry all of them.
    assert.match(liq, /requests_source = request\.queue\(id="requests"\)/);
    assert.match(liq, /beds_source = request\.queue\(id="beds"\)/);
    assert.match(liq, /stinger_source = playlist\(id="imaging_stingers"/);
    assert.match(liq, /promo_source = playlist\(id="imaging_promos"/);
    assert.match(liq, /id_source = playlist\(id="imaging_id"/);
    assert.match(liq, /emergency_source = playlist\(id="imaging_emergency"/);
  });

  test('source password flows from config.json, not a radio.liq edit', () => {
    assert.match(installSh, /sudo nano \/opt\/radioclyde\/app\/config\.json/);
    assert.match(installSh, /icecast\.sourcePassword must match/);
    // The old step told operators to edit config/radio.liq for the password;
    // that instruction must not come back.
    assert.doesNotMatch(installSh, /nano \/opt\/radioclyde\/config\/radio\.liq/);
  });

  test('guide no longer claims wishes never air (the Val 34 truth)', () => {
    assert.match(guide, /Želje poslušalcev gredo na eter \(Val 34\)/);
    assert.doesNotMatch(guide, /ne gredo v eter na tej predlogi/);
  });

  test('guide documents the pre-Val-34 template migration', () => {
    assert.match(guide, /Migracija obstoječih namestitev \(val 34\)/);
    assert.match(guide, /sudo systemctl daemon-reload && sudo systemctl restart liquidsoap-radioclyde/);
  });

  test('guide log hints read journald, not the template-era data/logs file', () => {
    // The template set log.file to /opt/radioclyde/data/logs/liquidsoap.log;
    // the reference logs to stdout -> journald. The old grep hint would
    // read a file nothing writes anymore.
    assert.doesNotMatch(guide, /data\/logs\/liquidsoap\.log/);
    assert.match(guide, /journalctl -u liquidsoap-radioclyde --no-pager/);
  });

  test('guide documents restart-both-services for the optional mounts', () => {
    // streams.liq regenerates on the radioclyde (web) boot; the engine
    // rereads it on its own restart -- one restart alone changes nothing.
    assert.match(guide, /restartajte OBE storitvi/);
  });

  test('upgrade runbook: the installer writes RADIOCLYDE_HOME itself', () => {
    assert.match(runbook, /Od vala 34 to namestilni/);
    assert.match(runbook, /Environment=RADIOCLYDE_HOME=\/opt\/radioclyde\/app/);
  });

  test('bash -n still accepts install.sh (structure, not just strings)', () => {
    // Cheap but real: the file must stay a PARSEABLE bash script after the
    // heredoc removal (a syntax error is exactly what this catches).
    execFileSync('bash', ['-n', path.join(repoRoot(), 'deploy', 'ubuntu', 'install.sh')]);
  });
});
