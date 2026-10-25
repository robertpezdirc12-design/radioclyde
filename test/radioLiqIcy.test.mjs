// radio.liq icy-identity structural regression (Paket B3,
// docs/programming-research.md §5): Liquidsoap can't run in CI, so (same
// pattern as radioLiqImaging.test.mjs / clockwheel.test.mjs) the test scans
// the SOURCE and pins the wiring the live stream depends on.
//
// It guards three directions:
//  - PRESENT: output.icecast advertises the station's static icy identity
//    (name/description/genre) in the reference radio.liq AND in the install.sh
//    template's heredoc copy -- with MATCHING values, so the two copies
//    cannot drift (the Val 20 A1 two-copies discipline applied to icy).
//  - ABSENT: no url= in the reference file (a placeholder URL would be a soft
//    lie on the dev box -- install.sh keeps its operator-editable url=), no
//    send_icy_metadata on the main output (per-track icy already flows via
//    the default; dynamic mount-description updates were deferred with the
//    roadmap's own blessing), and no icy keys inside the json.parse TYPE
//    record (the literal-first policy: an older config.json keeps booting).
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { repoRoot } from './fixtures.mjs';

const liqRaw = fs.readFileSync(path.join(repoRoot(), 'liquidsoap', 'radio.liq'), 'utf8');
// Strip Liquidsoap comments before matching: radio.liq's history comments
// deliberately NAME the constructs they document ("Icy identity (Paket B3)...")
// -- those mentions are documentation, not code, so every assertion below
// must run against comment-free source only (radioLiqImaging.test.mjs's
// pattern, verbatim).
const liq = liqRaw
  .split('\n')
  .map((line) => line.replace(/#.*$/, ''))
  .join('\n');

// The install.sh heredoc copy: shell # comments and Liquidsoap # comments
// strip the same way (the heredoc is single-quoted 'LIQ_EOF', so nothing is
// shell-expanded -- clockwheel.test.mjs reads it the same way).
const installSh = fs
  .readFileSync(path.join(repoRoot(), 'deploy', 'ubuntu', 'install.sh'), 'utf8')
  .split('\n')
  .map((line) => line.replace(/#.*$/, ''))
  .join('\n');

describe('radio.liq icy identity (output.icecast name/description/genre)', () => {
  test('reference output.icecast advertises the three icy literals', () => {
    assert.match(liq, /output\.icecast\(/);
    assert.match(liq, /name = "Radio Markec",/);
    assert.match(liq, /description = "Slovenian AI DJ Radio",/);
    assert.match(liq, /genre = "Various",/);
  });

  test('reference file deliberately has NO url= (soft-lie guard)', () => {
    // A placeholder URL would be advertised in icy on the dev box where no
    // such domain exists; the install.sh template keeps its operator-editable
    // url= for real deployments. If someone adds url= here, they should also
    // re-read the comment above output.icecast and update this pin knowingly.
    assert.doesNotMatch(liq, /url = "/);
  });

  test('install.sh heredoc copy carries the SAME three values (no drift)', () => {
    // Two radio.liq copies exist (reference + install.sh template) -- the A1
    // lesson: whatever is pinned in both must be pinned TOGETHER, or they
    // drift silently. install.sh's output.icecast also carries url=, which is
    // its own operator-editable placeholder and intentionally NOT mirrored.
    assert.match(installSh, /name="Radio Markec",/);
    assert.match(installSh, /description="Slovenian AI DJ Radio",/);
    assert.match(installSh, /genre="Various",/);
    assert.match(installSh, /url="https:\/\/your-domain\.com",/);
  });

  test('json.parse type record gains NO icy keys (literal-first policy)', () => {
    // The whole point of literals: radio.liq's typed json.parse stays
    // untouched, so an older config.json without any icy block still boots.
    // Pin the icecast record's exact key set.
    const typeMatch = liq.match(/icecast: \{([^}]*)\}/);
    assert.ok(typeMatch, 'json.parse icecast type record not found');
    const keys = typeMatch[1]
      .split(',')
      .map((k) => k.split(':')[0].trim())
      .filter(Boolean)
      .sort();
    assert.deepEqual(keys, ['bitrate', 'mount', 'port', 'sourceHost', 'sourcePassword']);
  });

  test('no send_icy_metadata on the main output (per-track icy already flows)', () => {
    // Dynamic "Sedaj: X" mount-description updates were deferred with the
    // roadmap's own blessing ("preveriti podporo Icecasta; če ni čista, samo
    // statični imeni"). The default icy metadata path already carries
    // per-track title/artist (director/playlist.js's annotations).
    assert.doesNotMatch(liq, /send_icy_metadata/);
  });
});
