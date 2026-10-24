// Tests for P4 #27 as-run report (src/auto/asrun.js + CLI):
//   A. window filtering: inclusive on both ends, lexical ISO compare,
//      deterministic chronological order,
//   B. rows: honest empty cells for missing fields, duration rounding,
//   C. CSV: RFC 4180 quoting (delimiter/quote/newline), stable header,
//   D. fail-open ledger: missing file -> empty report, corrupt line skipped
//      and counted, non-object JSON lines counted too,
//   E. summary: per-artist counts with deterministic tie-break, unique works,
//   F. writeAsrunFiles: self-describing filenames, byte-identical reruns.
// The module is pure (no config import) so tests point it at fixture paths.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import {
  readAiredFile,
  filterWindow,
  buildRows,
  buildSummary,
  csvField,
  toCsv,
  toSummaryText,
  writeAsrunFiles,
} from '../src/auto/asrun.js';

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'asrun-test-'));
}

function writeLedger(dir, entries) {
  const file = path.join(dir, 'aired.jsonl');
  fs.writeFileSync(file, entries.map((e) => JSON.stringify(e)).join('\n') + '\n');
  return file;
}

const entry = (playedAt, overrides = {}) => ({
  ratingKey: 'rk1',
  artist: 'Izvajalec A',
  title: 'Naslov 1',
  album: 'Album X',
  durationMs: 210_000,
  showId: 'jutro',
  playedAt,
  ...overrides,
});

describe('asrun window filtering', () => {
  test('window is inclusive on both ends and sorts chronologically', () => {
    const entries = [
      entry('2026-10-24T22:00:00+02:00'), // last day, latest hour
      entry('2026-10-20T06:30:00+02:00'), // first day
      entry('2026-10-22T12:00:00+02:00'), // middle
      entry('2026-10-19T23:59:59+02:00'), // before window
      entry('2026-10-25T00:00:01+02:00'), // after window
    ];
    const kept = filterWindow(entries, '2026-10-20', '2026-10-24');
    assert.deepEqual(
      kept.map((e) => e.playedAt.slice(0, 10)),
      ['2026-10-20', '2026-10-22', '2026-10-24'],
      'only the window survives, in ledger-time order'
    );
  });

  test('invalid dates and inverted windows throw with a Slovenian message', () => {
    assert.throws(() => filterWindow([], '24.10.2026', '2026-10-24'), /Neveljaven datum/);
    assert.throws(() => filterWindow([], '2026-10-24', '2026-10-20'), /zamenjaj vrstni red/);
  });

  test('entries without a usable playedAt are dropped, not fatal', () => {
    const kept = filterWindow([entry('2026-10-20T06:30:00+02:00'), { artist: 'x' }, { playedAt: null }], '2026-10-20', '2026-10-20');
    assert.equal(kept.length, 1);
  });
});

describe('asrun rows', () => {
  test('datum/ura come from the ledger prefix, duration rounds to seconds', () => {
    const [row] = buildRows([entry('2026-10-20T06:30:07+02:00', { durationMs: 210_499 })]);
    assert.equal(row.datum, '2026-10-20');
    assert.equal(row.ura, '06:30:07');
    assert.equal(row.trajanjeS, 210, '210.499 s rounds down to 210');
  });

  test('missing fields become empty cells, never shift columns', () => {
    const [row] = buildRows([{ playedAt: '2026-10-20T06:30:07+02:00', artist: 'A', title: 'T' }]);
    assert.equal(row.album, '');
    assert.equal(row.trajanjeS, '', 'no durationMs -> empty cell, not NaN/undefined');
    assert.equal(row.oddaja, '');
    assert.equal(toCsv([row]).match(/;/g).length, 12, 'header + one row, 6 delimiters each (7 columns)');
  });
});

describe('asrun CSV', () => {
  test('csvField quotes only what needs quoting and doubles inner quotes', () => {
    assert.equal(csvField('navadno'), 'navadno');
    assert.equal(csvField('z;podpičjem'), '"z;podpičjem"');
    assert.equal(csvField('reci "zdravo"'), '"reci ""zdravo"""');
    assert.equal(csvField('več\nvrstic'), '"več\nvrstic"');
  });

  test('toCsv: header first, one line per row, semicolon-delimited', () => {
    const csv = toCsv(buildRows([
      entry('2026-10-20T06:30:07+02:00'),
      entry('2026-10-20T06:34:00+02:00', { artist: 'B; C', title: 'Pesem, "velika"' }),
    ]));
    const lines = csv.split('\n');
    assert.equal(lines[0], 'datum;ura;izvajalec;naslov;album;trajanje_s;oddaja');
    assert.match(lines[1], /^2026-10-20;06:30:07;Izvajalec A;Naslov 1;Album X;210;jutro$/);
    assert.match(lines[2], /^2026-10-20;06:34:00;"B; C";"Pesem, ""velika"""/);
    assert.equal(csv.endsWith('\n'), true);
  });
});

describe('asrun ledger reading (fail-open)', () => {
  test('missing file -> empty report, fileExists false', () => {
    const r = readAiredFile(path.join(tmpDir(), 'ne-obstaja.jsonl'));
    assert.deepEqual(r, { entries: [], corruptCount: 0, fileExists: false });
    // and the full pipeline still produces a valid (header-only) CSV
    const csv = toCsv(buildRows(filterWindow(r.entries, '2026-10-01', '2026-10-31')));
    assert.equal(csv.split('\n')[0], 'datum;ura;izvajalec;naslov;album;trajanje_s;oddaja');
    assert.equal(csv.split('\n')[1], '');
  });

  test('corrupt lines are skipped and counted, good rows survive', () => {
    const dir = tmpDir();
    const file = path.join(dir, 'aired.jsonl');
    fs.writeFileSync(file, [
      JSON.stringify(entry('2026-10-20T06:30:00+02:00')),
      'to ni json',
      JSON.stringify({ playedAt: '2026-10-20T07:00:00+02:00', artist: 'B', title: 'T' }),
      '[1,2,3]', // valid JSON, but not an object
    ].join('\n') + '\n');
    const r = readAiredFile(file);
    assert.equal(r.entries.length, 2);
    assert.equal(r.corruptCount, 2, 'the text line AND the non-object line count as corrupt');
    assert.equal(r.fileExists, true);
  });
});

describe('asrun summary', () => {
  test('per-artist counts, unique works, deterministic tie-break', () => {
    const rows = buildRows([
      entry('2026-10-20T06:30:00+02:00', { artist: 'Zet', title: 'P1' }),
      entry('2026-10-20T07:00:00+02:00', { artist: 'Zet', title: 'P2' }),
      entry('2026-10-20T08:00:00+02:00', { artist: 'Ana', title: 'P1' }),
      entry('2026-10-21T08:00:00+02:00', { artist: 'Ana', title: 'P2' }),
      entry('2026-10-21T09:00:00+02:00', { artist: 'Ana', title: 'P3' }),
    ]);
    const s = buildSummary(rows);
    assert.equal(s.total, 5);
    assert.equal(s.uniqueWorks, 5);
    assert.equal(s.uniqueArtists, 2);
    assert.deepEqual(s.artists.map((a) => a.artist), ['Ana', 'Zet'], '3 plays beats 2');
    // tie: same plays -> alphabetical, every time
    const tied = buildSummary(buildRows([
      entry('2026-10-20T06:30:00+02:00', { artist: 'Zet', title: 'P1' }),
      entry('2026-10-20T07:00:00+02:00', { artist: 'Ana', title: 'P1' }),
    ]));
    assert.deepEqual(tied.artists.map((a) => a.artist), ['Ana', 'Zet']);
  });

  test('empty summary renders a valid (zero) report text', () => {
    const txt = toSummaryText(buildSummary([]), '2026-10-01', '2026-10-31');
    assert.match(txt, /Skupaj predvajanj: 0/);
    assert.match(txt, /Obdobje: 2026-10-01 \.\. 2026-10-31/);
  });
});

describe('asrun file writing', () => {
  test('writes self-describing filenames, byte-identical on rerun', () => {
    const dir = tmpDir();
    const entries = [entry('2026-10-20T06:30:00+02:00'), entry('2026-10-21T07:00:00+02:00')];
    const rows = buildRows(filterWindow(entries, '2026-10-20', '2026-10-21'));
    const payload = { csv: toCsv(rows), summaryText: toSummaryText(buildSummary(rows), '2026-10-20', '2026-10-21') };

    const { csvPath, summaryPath } = writeAsrunFiles(payload, path.join(dir, 'asrun'), '2026-10-20', '2026-10-21');
    assert.equal(path.basename(csvPath), 'asrun-2026-10-20-2026-10-21.csv');
    assert.equal(path.basename(summaryPath), 'asrun-2026-10-20-2026-10-21-povzetek.txt');
    const csvOnce = fs.readFileSync(csvPath, 'utf8');
    const txtOnce = fs.readFileSync(summaryPath, 'utf8');

    writeAsrunFiles(payload, path.join(dir, 'asrun'), '2026-10-20', '2026-10-21');
    assert.equal(fs.readFileSync(csvPath, 'utf8'), csvOnce, 'same inputs -> byte-identical CSV');
    assert.equal(fs.readFileSync(summaryPath, 'utf8'), txtOnce, 'same inputs -> byte-identical summary');
    assert.match(txtOnce, /Največ predvajanj po izvajalcih:\n1\. Izvajalec A — 2/);
  });
});
