// fetch-liquidsoap harness contracts (Val 30): scripts/fetch-liquidsoap.mjs
// + scripts/ldshim.c are the in-repo way to run the OFFICIAL Liquidsoap
// binaries (registry pull -> userspace rootfs -> wrapper) that
// docs/liquidsoap-upgrade.md uses for its 2.4.6 pre-flight --check.
//
// The tool itself is network-bound (anonymous registry pulls), so these tests
// pin everything that is OFFLINE-deterministic, in the same spirit as the
// structural .liq tests (radioLiqImaging/radioLiqIcy): pure functions with
// fixtures, the CLI surface, the wrapper's path discipline, the shim's
// interposition set, and the radio.liq cross-build getenv fix the harness
// itself discovered on 2026-10-27 (the runbook's validation matrix is the
// live half of this contract).
//
// Optional, skip-guarded like autocueHead's ffmpeg: when gcc is present the
// shim must actually COMPILE -- that is the test that would have caught the
// struct stat64 signature class of breakage the first sandbox run hit.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

import {
  parseArgs,
  selectPlatformManifest,
  isIndexBody,
  tarExtractArgs,
  tarListArgs,
  whiteoutKind,
  needsShimForTag,
  buildRunSh,
  applyWhiteouts,
  removeWhiteoutMarkers,
  MANIFEST_ACCEPT,
} from '../scripts/fetch-liquidsoap.mjs';
import { repoRoot } from './fixtures.mjs';

const hasGcc = (() => {
  try {
    return spawnSync('gcc', ['--version'], { encoding: 'utf8' }).status === 0;
  } catch {
    return false;
  }
})();

describe('fetch-liquidsoap: CLI parsing', () => {
  test('defaults: both runbook tags, repo-relative cache dir, amd64', () => {
    const o = parseArgs([]);
    assert.deepEqual(o.tags, ['v2.2.4', 'v2.4.6']);
    assert.equal(o.dir, '.liq-bin');
    assert.deepEqual(o.platform, { os: 'linux', arch: 'amd64' });
    assert.equal(o.force, false);
    assert.equal(o.selfTest, true);
    assert.equal(o.help, false);
  });

  test('--tags accepts a comma list and a single tag', () => {
    assert.deepEqual(parseArgs(['--tags', 'v2.4.6']).tags, ['v2.4.6']);
    assert.deepEqual(parseArgs(['--tags', 'v2.2.4,v2.4.6,v2.3.0']).tags, [
      'v2.2.4',
      'v2.4.6',
      'v2.3.0',
    ]);
  });

  test('unknown argument fails honestly (names the argument)', () => {
    assert.throws(() => parseArgs(['--bogus']), /--bogus/);
  });

  test('missing values and malformed platform fail honestly', () => {
    assert.throws(() => parseArgs(['--tags']), /--tags needs a value/);
    assert.throws(() => parseArgs(['--dir']), /--dir needs a value/);
    assert.throws(() => parseArgs(['--platform', 'amd64']), /os\/arch/);
  });

  test('flag options', () => {
    const o = parseArgs(['--force', '--no-selftest', '--platform', 'linux/arm64', '--dir', '/tmp/x']);
    assert.equal(o.force, true);
    assert.equal(o.selfTest, false);
    assert.deepEqual(o.platform, { os: 'linux', arch: 'arm64' });
    assert.equal(o.dir, '/tmp/x');
    assert.equal(parseArgs(['--help']).help, true);
  });

  test('CLI --help exits 0 with usage and NO network side effects', () => {
    const r = spawnSync(process.execPath, [path.join(repoRoot(), 'scripts', 'fetch-liquidsoap.mjs'), '--help'], {
      encoding: 'utf8',
      timeout: 30_000,
    });
    assert.equal(r.status, 0);
    assert.match(r.stdout, /Usage: node scripts\/fetch-liquidsoap\.mjs/);
    assert.match(r.stdout, /--tags/);
    assert.match(r.stdout, /Anonymous registry pulls only/);
  });

  test('CLI rejects unknown arguments with exit 1 and the argument named', () => {
    const r = spawnSync(process.execPath, [path.join(repoRoot(), 'scripts', 'fetch-liquidsoap.mjs'), '--nope'], {
      encoding: 'utf8',
      timeout: 30_000,
    });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /unknown argument: --nope/);
  });
});

describe('fetch-liquidsoap: manifest selection', () => {
  const index = {
    mediaType: 'application/vnd.oci.image.index.v1+json',
    manifests: [
      { digest: 'sha256:aaa', platform: { os: 'linux', architecture: 'arm64', variant: 'v8' } },
      { digest: 'sha256:bbb', platform: { os: 'linux', architecture: 'amd64' } },
      { digest: 'sha256:ccc', platform: { os: 'linux', architecture: 'riscv64' } },
    ],
  };

  test('picks the linux/amd64 child digest, skipping variant entries', () => {
    assert.equal(selectPlatformManifest(index), 'sha256:bbb');
  });

  test('honors a custom platform', () => {
    assert.equal(selectPlatformManifest(index, 'linux', 'riscv64'), 'sha256:ccc');
  });

  test('returns null for a missing platform, a plain manifest, or garbage', () => {
    assert.equal(selectPlatformManifest(index, 'linux', 'mips'), null);
    assert.equal(selectPlatformManifest({ layers: [] }), null);
    assert.equal(selectPlatformManifest(null), null);
    assert.equal(selectPlatformManifest({ manifests: [] }), null);
  });

  test('isIndexBody distinguishes indexes from image manifests', () => {
    assert.equal(isIndexBody(index), true);
    assert.equal(isIndexBody({ schemaVersion: 2, layers: [{ digest: 'x' }] }), false);
    assert.equal(isIndexBody(null), false);
  });

  test('MANIFEST_ACCEPT covers both OCI and docker index/manifest shapes', () => {
    for (const mt of [
      'application/vnd.oci.image.index.v1+json',
      'application/vnd.docker.distribution.manifest.list.v2+json',
      'application/vnd.oci.image.manifest.v1+json',
      'application/vnd.docker.distribution.manifest.v2+json',
    ]) {
      assert.ok(MANIFEST_ACCEPT.includes(mt), mt);
    }
  });
});

describe('fetch-liquidsoap: layer handling', () => {
  test('tar flags per media type (extract and list agree)', () => {
    assert.deepEqual(tarExtractArgs('application/vnd.oci.image.layer.v1.tar+gzip'), ['-xzf']);
    assert.deepEqual(tarListArgs('application/vnd.oci.image.layer.v1.tar+gzip'), ['-tzf']);
    assert.deepEqual(tarExtractArgs('application/vnd.docker.image.rootfs.diff.tar.gzip'), ['-xzf']);
    assert.deepEqual(tarExtractArgs('application/vnd.oci.image.layer.v1.tar'), ['-xf']);
    assert.deepEqual(tarExtractArgs('application/vnd.oci.image.layer.v1.tar+zstd'), ['--zstd', '-xf']);
  });

  test('unknown media types are rejected honestly, case-insensitively accepted', () => {
    assert.equal(tarExtractArgs('application/vnd.oci.image.layer.v1.tar+xz'), null);
    assert.equal(tarExtractArgs(null), null);
    assert.deepEqual(tarExtractArgs('APPLICATION/VND.OCI.IMAGE.LAYER.V1.TAR+GZIP'), ['-xzf']);
  });

  test('whiteoutKind: opaque, delete, and non-whiteout', () => {
    assert.equal(whiteoutKind('.wh..wh..opq'), 'opaque');
    assert.equal(whiteoutKind('.wh.var-lib-apt'), 'delete');
    assert.equal(whiteoutKind('plain.txt'), null);
    assert.equal(whiteoutKind(''), null);
    assert.equal(whiteoutKind(null), null);
  });

  test('applyWhiteouts PRE-pass: delete marker removes the LOWER-layer target, keeps the rest', () => {
    // Simulates the state before this layer is extracted: lower layers left
    // gone.txt behind; the marker is only a tar LISTING entry so far.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wh-del-'));
    try {
      fs.mkdirSync(path.join(dir, 'sub'));
      fs.writeFileSync(path.join(dir, 'sub', 'keep.txt'), 'k');
      fs.writeFileSync(path.join(dir, 'sub', 'gone.txt'), 'g');
      const applied = applyWhiteouts(dir, ['sub/.wh.gone.txt']);
      assert.deepEqual(fs.readdirSync(path.join(dir, 'sub')), ['keep.txt']);
      assert.deepEqual(applied, ['delete sub/gone.txt']);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('applyWhiteouts PRE-pass: opaque marker clears lower-layer children only', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wh-opq-'));
    try {
      fs.mkdirSync(path.join(dir, 'op'));
      fs.writeFileSync(path.join(dir, 'op', 'old.txt'), 'o'); // lower layer
      const applied = applyWhiteouts(dir, ['op/new.txt', 'op/.wh..wh..opq']);
      assert.deepEqual(fs.readdirSync(path.join(dir, 'op')), []);
      assert.deepEqual(applied, ['opaque op']);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('full layer sequence: PRE deletions, extraction, POST marker removal', () => {
    // The ordering contract the first implementation got wrong (an opaque
    // marker applied AFTER extraction wiped the layer's own new.txt):
    // deletions PRE, files extracted, markers unlinked POST.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wh-seq-'));
    try {
      fs.mkdirSync(path.join(dir, 'op'));
      fs.writeFileSync(path.join(dir, 'op', 'old.txt'), 'o'); // lower layer
      const entries = ['op/new.txt', 'op/.wh..wh..opq'];
      assert.deepEqual(applyWhiteouts(dir, entries), ['opaque op']);
      // "tar -x" would now write new.txt AND the marker file:
      fs.writeFileSync(path.join(dir, 'op', 'new.txt'), 'n');
      fs.writeFileSync(path.join(dir, 'op', '.wh..wh..opq'), '');
      removeWhiteoutMarkers(dir, entries);
      assert.deepEqual(fs.readdirSync(path.join(dir, 'op')).sort(), ['new.txt']);
      assert.equal(fs.readFileSync(path.join(dir, 'op', 'new.txt'), 'utf8'), 'n');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('applyWhiteouts: non-whiteout entries are a no-op', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wh-noop-'));
    try {
      fs.writeFileSync(path.join(dir, 'a.txt'), 'a');
      assert.deepEqual(applyWhiteouts(dir, ['a.txt']), []);
      assert.deepEqual(removeWhiteoutMarkers(dir, ['a.txt']), undefined);
      assert.ok(fs.existsSync(path.join(dir, 'a.txt')));
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('fetch-liquidsoap: wrapper generation', () => {
  const base = {
    tag: 'v2.4.6',
    loaderRel: 'usr/lib/x86_64-linux-gnu/ld-linux-x86-64.so.2',
    binRel: 'usr/bin/liquidsoap',
    libDirs: ['usr/lib/x86_64-linux-gnu', 'usr/lib'],
    stdlibRel: 'usr/share/liquidsoap/libs/stdlib.liq',
  };

  test('2.3+ wrapper: --stdlib points INSIDE the rootfs, no shim', () => {
    const sh = buildRunSh({ ...base, shim: null });
    assert.match(sh, /exec "\$LOADER" --library-path "\$LIBS" "\$BIN" --stdlib "\$ROOT\/rootfs\/usr\/share\/liquidsoap\/libs\/stdlib\.liq" "\$@"/);
    assert.doesNotMatch(sh, /LD_PRELOAD|LDSHIM_PREFIX/);
    assert.match(sh, /# 2\.3\+ resolves its stdlib via --stdlib/);
  });

  test('2.2.x wrapper: shim env + preload, no --stdlib', () => {
    const sh = buildRunSh({ ...base, tag: 'v2.2.4', shim: 'ldshim.so' });
    assert.match(sh, /export LDSHIM_PREFIX="\$ROOT\/rootfs"/);
    assert.match(sh, /export LD_PRELOAD="\$ROOT\/ldshim\.so"/);
    assert.match(sh, /exec "\$LOADER" --library-path "\$LIBS" "\$BIN" "\$@"/);
    assert.doesNotMatch(sh, /--stdlib/);
  });

  test('PATH DISCIPLINE (2026-10-27 regression): every \$ROOT path except ldshim.so lives under rootfs/', () => {
    // The first sandbox run failed with "loader not found" because LOADER/BIN/
    // LIBS/--stdlib lacked the rootfs/ prefix. This pin keeps that class dead.
    for (const sh of [
      buildRunSh({ ...base, shim: null }),
      buildRunSh({ ...base, tag: 'v2.2.4', shim: 'ldshim.so' }),
    ]) {
      const offenders = sh
        .split('\n')
        .filter((l) => /\$ROOT\/(?!rootfs)/.test(l) && !l.includes('ldshim.so'));
      assert.deepEqual(offenders, []);
    }
  });

  test('library dirs ride in the loader --library-path, joined with :', () => {
    const sh = buildRunSh({ ...base, libDirs: ['usr/lib/x86_64-linux-gnu', 'usr/lib'], shim: null });
    assert.match(sh, /LIBS="\$ROOT\/rootfs\/usr\/lib\/x86_64-linux-gnu:\$ROOT\/rootfs\/usr\/lib"/);
  });

  test('needsShimForTag: 2.2.x yes, 2.3+ no, unknown assumes the old engine', () => {
    assert.equal(needsShimForTag('v2.2.4'), true);
    assert.equal(needsShimForTag('2.2.4'), true);
    assert.equal(needsShimForTag('v2.2.0'), true);
    assert.equal(needsShimForTag('v2.3.0'), false);
    assert.equal(needsShimForTag('v2.4.6'), false);
    assert.equal(needsShimForTag('v3.0.0'), false);
    assert.equal(needsShimForTag('latest'), true);
  });
});

describe('fetch-liquidsoap: shipped files', () => {
  test('scripts/ldshim.c exists and interposes the stdlib-load call family', () => {
    const c = fs.readFileSync(path.join(repoRoot(), 'scripts', 'ldshim.c'), 'utf8');
    // The captured prefix (what 2.2.x hardcodes for its stdlib):
    assert.match(c, /\/usr\/share\/liquidsoap/);
    // The four families the 2026-10-24 live run proved sufficient, plus the
    // insurance set -- each must actually interpose via RTLD_NEXT:
    for (const fn of ['"open"', '"open64"', '"openat"', '"stat"', '"stat64"', '"lstat"',
      '"__xstat"', '"__lxstat"', '"fstatat"', '"access"', '"faccessat"',
      '"mkdir"', '"opendir"', '"fopen"']) {
      assert.ok(c.includes(`dlsym(RTLD_NEXT, ${fn})`), fn);
    }
    // Only the engine's own stdlib prefix may be redirected:
    assert.match(c, /kCaptured\[\]\s*=\s*\{\s*"\/usr\/share\/liquidsoap",\s*NULL,\s*\}/);
  });

  test('the shim uses struct stat64 for the 64-bit stat variants (gcc header contract)', () => {
    // The 2026-10-27 first compile failed exactly here: glibc declares
    // stat64/lstat64/fstatat64/__xstat64/__lxstat64 with struct stat64.
    const c = fs.readFileSync(path.join(repoRoot(), 'scripts', 'ldshim.c'), 'utf8');
    for (const fn of ['stat64', 'lstat64', 'fstatat64', '__xstat64', '__lxstat64']) {
      const m = new RegExp(`int ${fn}\\((?:int [a-z]+, )?const char \\*[^,]+, struct stat64`).exec(c);
      assert.ok(m, `${fn} must take struct stat64`);
    }
  });

  test('SKIP-GUARDED (gcc present): the shim actually compiles', { skip: !hasGcc }, () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ldshim-'));
    try {
      const out = path.join(dir, 'ldshim.so');
      const r = spawnSync(
        'gcc',
        ['-shared', '-fPIC', '-O2', '-o', out, path.join(repoRoot(), 'scripts', 'ldshim.c')],
        { encoding: 'utf8', timeout: 60_000 },
      );
      assert.equal(r.status, 0, r.stderr);
      assert.ok(fs.existsSync(out));
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('.gitignore keeps the extracted binaries out of the tree', () => {
    const gi = fs.readFileSync(path.join(repoRoot(), '.gitignore'), 'utf8');
    assert.match(gi, /^\.liq-bin\/$/m);
  });
});

describe('radio.liq cross-build environment access (the bug this harness caught)', () => {
  // 2026-10-27: the official 2.4.6 binary refused to PARSE radio.liq at the
  // RADIOCLYDE_HOME line -- bare getenv is a deprecated alias whose shape
  // differs per build (2.2.x: (name); 2.4.6 deprecations.liq:
  // getenv(default="", v) with the default FIRST and positional, so the old
  // call is a partial application). environment.get(name) is byte-identical
  // in both stdlibs (labeled ~default="" is omittable at the call site).
  // This pin keeps the both-builds form in place.
  const stripComments = (text) =>
    text
      .split('\n')
      .map((line) => line.replace(/#.*$/, ''))
      .join('\n');

  const liq = stripComments(fs.readFileSync(path.join(repoRoot(), 'liquidsoap', 'radio.liq'), 'utf8'));

  test('RADIOCLYDE_HOME resolves through environment.get (both-builds form)', () => {
    assert.match(liq, /let home = if environment\.get\("RADIOCLYDE_HOME"\) == ""/);
    assert.match(liq, /else environment\.get\("RADIOCLYDE_HOME"\) end/);
  });

  test('NO bare getenv( call remains in radio.liq code', () => {
    assert.doesNotMatch(liq, /\bgetenv\(/);
  });
});
