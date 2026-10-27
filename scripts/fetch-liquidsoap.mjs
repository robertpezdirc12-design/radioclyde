#!/usr/bin/env node
// fetch-liquidsoap.mjs -- run the OFFICIAL Liquidsoap binaries userspace,
// without root and without docker, for upgrade pre-flight checks.
//
// What it does (per tag, default v2.2.4 + v2.4.6):
//   1. anonymous pull from registry-1.docker.io (savonet/liquidsoap) --
//      auth.docker.io token, manifest (index -> linux/amd64 if needed),
//      layer blobs streamed to disk;
//   2. layer-by-layer extraction into .liq-bin/<tag>/rootfs with OCI
//      whiteout handling (.wh.<name> deletes, .wh..wh..opq clears a dir),
//      via the system tar;
//   3. locates the engine binary + its OWN ld-linux loader + real lib dirs
//      (Debian's /lib64 loader path is an ABSOLUTE symlink -- it would
//      resolve to the HOST loader, so only regular files are accepted);
//   4. writes .liq-bin/<tag>/run.sh:
//        2.2.x: LD_PRELOAD shim (scripts/ldshim.c, compiled with gcc) that
//               rewrites the hardcoded /usr/share/liquidsoap into the rootfs
//               via LDSHIM_PREFIX;
//        2.3+:  --stdlib <rootfs>/.../stdlib.liq (the FILE -- Runtime.libs
//               rejects the directory), no shim needed;
//   5. self-test: run.sh --version must exit 0.
//
// Why this exists: docs/liquidsoap-upgrade.md is the box-side runbook for
// 2.2.4 -> 2.4.6, and its step 3 ("--check with the NEW binary BEFORE
// switching production") used to require building 2.4.6 from source first.
// With this tool the pre-flight check runs against the official image's
// binary in ~5 minutes on any Linux box with node, tar and (for 2.2.x only)
// gcc. The identical procedure validated the radio.liq gates on 2026-10-24
// and again, as THIS in-repo script, on 2026-10-27 -- see the validation
// matrix in docs/liquidsoap-upgrade.md.
//
// Doctrine: zero new dependencies (Node >= 24's global fetch), honest
// failures with the exact fix in the message, nothing persisted outside
// --dir (which is gitignored). Anonymous registry access only -- no
// credentials, no writes to the registry.
//
// Usage:
//   node scripts/fetch-liquidsoap.mjs [--tags v2.2.4,v2.4.6] [--dir .liq-bin]
//        [--platform linux/amd64] [--force] [--no-selftest]
//
// Then (from the repo root, with a config.json that satisfies radio.liq's
// typed json.parse -- dataDir, icecast{...}, liquidsoap{...}):
//   cd liquidsoap
//   RADIOCLYDE_HOME=/path/to/home-with-config ../.liq-bin/v2.2.4/run.sh --check radio.liq
//   RADIOCLYDE_HOME=/path/to/home-with-config ../.liq-bin/v2.4.6/run.sh --check radio.liq

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const AUTH_URL =
  'https://auth.docker.io/token?service=registry.docker.io&scope=repository:savonet/liquidsoap:pull';
export const REGISTRY = 'https://registry-1.docker.io';
export const REPO = 'savonet/liquidsoap';

// Ask for everything we can parse; the registry answers with one.
export const MANIFEST_ACCEPT = [
  'application/vnd.oci.image.index.v1+json',
  'application/vnd.docker.distribution.manifest.list.v2+json',
  'application/vnd.oci.image.manifest.v1+json',
  'application/vnd.docker.distribution.manifest.v2+json',
].join(', ');

export const EMPTY_LAYER_DIGEST =
  'sha256:44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a';

export const HELP = `Usage: node scripts/fetch-liquidsoap.mjs [options]

Options:
  --tags <a,b,...>     image tags to fetch (default: v2.2.4,v2.4.6)
  --dir <path>         cache dir, relative to the repo root (default: .liq-bin)
  --platform <o/a>     image platform (default: linux/amd64)
  --force              re-download layers even if they are already cached
  --no-selftest        skip the run.sh --version smoke test
  --help               this text

Everything lands inside --dir (gitignored). Anonymous registry pulls only.`;

export function parseArgs(argv) {
  const opts = {
    tags: ['v2.2.4', 'v2.4.6'],
    dir: '.liq-bin',
    platform: { os: 'linux', arch: 'amd64' },
    force: false,
    selfTest: true,
    help: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--tags') {
      const raw = argv[++i];
      if (!raw) throw new Error('--tags needs a value, e.g. v2.2.4,v2.4.6');
      opts.tags = raw.split(',').map((s) => s.trim()).filter(Boolean);
      if (!opts.tags.length) throw new Error('--tags produced no tags');
    } else if (a === '--dir') {
      opts.dir = argv[++i];
      if (!opts.dir) throw new Error('--dir needs a value');
    } else if (a === '--platform') {
      const raw = argv[++i];
      if (!raw || !raw.includes('/')) throw new Error('--platform needs os/arch, e.g. linux/amd64');
      const [os, arch] = raw.split('/');
      if (!os || !arch) throw new Error('--platform needs os/arch, e.g. linux/amd64');
      opts.platform = { os, arch };
    } else if (a === '--force') {
      opts.force = true;
    } else if (a === '--no-selftest') {
      opts.selfTest = false;
    } else if (a === '--help' || a === '-h') {
      opts.help = true;
    } else {
      throw new Error(`unknown argument: ${a} (see --help)`);
    }
  }
  return opts;
}

// Manifest/index helpers ------------------------------------------------------

// Returns the amd64 (or requested) child digest from an OCI index / docker
// manifest list, or null when `body` is not an index at all.
export function selectPlatformManifest(body, os = 'linux', arch = 'amd64') {
  const manifests = body && Array.isArray(body.manifests) ? body.manifests : null;
  if (!manifests) return null;
  const hit = manifests.find(
    (m) =>
      m &&
      typeof m.digest === 'string' &&
      m.platform &&
      m.platform.os === os &&
      m.platform.architecture === arch &&
      !m.platform.variant,
  );
  return hit ? hit.digest : null;
}

export function isIndexBody(body) {
  return Array.isArray(body && body.manifests);
}

// Layer media types -> tar flags. Unknown types are rejected honestly.
export function tarExtractArgs(mediaType) {
  switch (String(mediaType || '').toLowerCase()) {
    case 'application/vnd.oci.image.layer.v1.tar+gzip':
    case 'application/vnd.docker.image.rootfs.diff.tar.gzip':
      return ['-xzf'];
    case 'application/vnd.oci.image.layer.v1.tar':
    case 'application/vnd.docker.image.rootfs.diff.tar':
      return ['-xf'];
    case 'application/vnd.oci.image.layer.v1.tar+zstd':
      return ['--zstd', '-xf'];
    default:
      return null;
  }
}

export function tarListArgs(mediaType) {
  switch (String(mediaType || '').toLowerCase()) {
    case 'application/vnd.oci.image.layer.v1.tar+gzip':
    case 'application/vnd.docker.image.rootfs.diff.tar.gzip':
      return ['-tzf'];
    case 'application/vnd.oci.image.layer.v1.tar':
    case 'application/vnd.docker.image.rootfs.diff.tar':
      return ['-tf'];
    case 'application/vnd.oci.image.layer.v1.tar+zstd':
      return ['--zstd', '-tf'];
    default:
      return null;
  }
}

// Whiteouts (OCI image spec): .wh.<name> deletes <name>, .wh..wh..opq makes
// the directory opaque (everything from lower layers is gone).
export function whiteoutKind(name) {
  if (name === '.wh..wh..opq') return 'opaque';
  if (typeof name === 'string' && name.startsWith('.wh.')) return 'delete';
  return null;
}

// 2.2.x needs the LD_PRELOAD shim (hardcoded /usr/share/liquidsoap);
// 2.3+ takes --stdlib and needs nothing.
export function needsShimForTag(tag) {
  const m = /^v?(\d+)\.(\d+)/.exec(String(tag));
  if (!m) return true; // unknown version shape: assume the old engine
  const [major, minor] = [Number(m[1]), Number(m[2])];
  return !(major > 2 || (major === 2 && minor >= 3));
}

// Filesystem helpers ----------------------------------------------------------

export function binaryCandidates() {
  return ['usr/bin/liquidsoap', 'usr/local/bin/liquidsoap'];
}

// Order matters: Debian's /lib64/ld-linux-x86-64.so.2 is an ABSOLUTE symlink
// to /lib/x86_64-linux-gnu/... which resolves against the HOST -- only a
// regular file is a safe loader to exec.
export function loaderCandidates() {
  return [
    'lib64/ld-linux-x86-64.so.2',
    'lib/x86_64-linux-gnu/ld-linux-x86-64.so.2',
    'usr/lib64/ld-linux-x86-64.so.2',
    'usr/lib/x86_64-linux-gnu/ld-linux-x86-64.so.2',
  ];
}

export function stdlibCandidates() {
  return [
    'usr/share/liquidsoap/libs/stdlib.liq',
    'usr/share/liquidsoap/stdlib.liq',
    'usr/local/share/liquidsoap/libs/stdlib.liq',
  ];
}

function firstRegularFile(rootfs, relCandidates) {
  for (const rel of relCandidates) {
    const p = path.join(rootfs, rel);
    try {
      if (fs.lstatSync(p).isFile()) return rel;
    } catch {
      // absent or a symlink -- keep looking
    }
  }
  return null;
}

function libraryDirs(rootfs) {
  const candidates = [
    'usr/lib/x86_64-linux-gnu',
    'usr/lib64',
    'usr/lib',
    'lib/x86_64-linux-gnu',
    'lib64',
    'lib',
  ];
  const found = [];
  const seen = new Set();
  const pushIfExists = (rel) => {
    if (seen.has(rel)) return;
    seen.add(rel);
    try {
      if (fs.statSync(path.join(rootfs, rel)).isDirectory()) found.push(rel);
    } catch {
      // not in this image
    }
  };
  for (const rel of candidates) pushIfExists(rel);

  // What a REAL system gets from ldconfig: the image's own ld.so.conf.d.
  // Absolute paths inside the conf files map straight into the rootfs.
  const confD = path.join(rootfs, 'etc', 'ld.so.conf.d');
  let confFiles = [];
  try {
    confFiles = fs.readdirSync(confD).filter((f) => f.endsWith('.conf'));
  } catch {
    // no ld.so.conf.d in this image
  }
  for (const f of confFiles) {
    let text = '';
    try {
      text = fs.readFileSync(path.join(confD, f), 'utf8');
    } catch {
      continue;
    }
    for (let line of text.split('\n')) {
      line = line.trim();
      if (!line || line.startsWith('#') || !line.startsWith('/')) continue;
      pushIfExists(line.replace(/^\//, ''));
    }
  }

  // Debian ships PRIVATE library dirs referenced only by ABSOLUTE DT_RUNPATH
  // (e.g. /usr/lib/x86_64-linux-gnu/pulseaudio for libpulsecommon, which
  // libpulse-simple NEEDEDs -- the 2026-10-27 2.2.4 self-test caught exactly
  // that). On a real box the absolute path exists; userspace it must ride in
  // --library-path, because ld.so resolves its own dependencies with internal
  // syscalls and LD_PRELOAD cannot interpose them. A one-level scan under the
  // multiarch dir catches this class without needing readelf at run time.
  // Kept AFTER the standard dirs so a same-soname lib in a standard dir can
  // never be shadowed by a private one.
  const multiarch = path.join(rootfs, 'usr', 'lib', 'x86_64-linux-gnu');
  let subdirs = [];
  try {
    subdirs = fs.readdirSync(multiarch, { withFileTypes: true });
  } catch {
    // no multiarch dir in this image
  }
  for (const e of subdirs) {
    if (!e.isDirectory()) continue;
    let children = [];
    try {
      children = fs.readdirSync(path.join(multiarch, e.name));
    } catch {
      continue;
    }
    if (children.some((c) => c.includes('.so'))) {
      pushIfExists(`usr/lib/x86_64-linux-gnu/${e.name}`);
    }
  }
  return found;
}

// Build the run.sh wrapper. Pure function -> unit-testable offline.
export function buildRunSh({ tag, loaderRel, binRel, libDirs, shim, stdlibRel }) {
  const lines = [
    '#!/bin/sh',
    '# Generated by scripts/fetch-liquidsoap.mjs -- rerun the tool instead of editing.',
    `# Official savonet/liquidsoap ${tag}, extracted userspace (no root, no docker).`,
    '# Docs: docs/liquidsoap-upgrade.md (validation matrix + pre-flight usage).',
    'set -e',
    'ROOT="$(cd "$(dirname "$0")" && pwd)"',
    `LOADER="$ROOT/rootfs/${loaderRel}"`,
    `BIN="$ROOT/rootfs/${binRel}"`,
    `LIBS="${libDirs.map((d) => `$ROOT/rootfs/${d}`).join(':')}"`,
  ];
  if (shim) {
    lines.push(
      '# 2.2.x hardcodes /usr/share/liquidsoap for its stdlib: the LD_PRELOAD',
      '# shim (scripts/ldshim.c) rewrites those paths into the rootfs below.',
      `export LDSHIM_PREFIX="$ROOT/rootfs"`,
      `export LD_PRELOAD="$ROOT/${path.basename(shim)}"`,
      'exec "$LOADER" --library-path "$LIBS" "$BIN" "$@"',
    );
  } else {
    lines.push(
      '# 2.3+ resolves its stdlib via --stdlib (the FILE, not the directory).',
      `exec "$LOADER" --library-path "$LIBS" "$BIN" --stdlib "$ROOT/rootfs/${stdlibRel}" "$@"`,
    );
  }
  return lines.join('\n') + '\n';
}

// Registry plumbing ------------------------------------------------------------

async function getToken() {
  const res = await fetch(AUTH_URL, { signal: AbortSignal.timeout(30_000) });
  if (!res.ok) throw new Error(`auth.docker.io token: HTTP ${res.status} -- registry unreachable?`);
  const body = await res.json();
  if (!body || typeof body.token !== 'string' || !body.token) {
    throw new Error('auth.docker.io returned no token (anonymous pull should need none)');
  }
  return body.token;
}

async function fetchManifest(token, reference) {
  const url = `${REGISTRY}/v2/${REPO}/manifests/${reference}`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${token}`, Accept: MANIFEST_ACCEPT },
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) {
    throw new Error(`manifest ${reference}: HTTP ${res.status} ${res.statusText}`);
  }
  const mediaType = (res.headers.get('content-type') || '').split(';')[0].trim();
  return { mediaType, body: await res.json() };
}

async function downloadBlob(token, digest, dest) {
  const url = `${REGISTRY}/v2/${REPO}/blobs/${digest}`;
  let res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (res.status === 401) {
    // token expired mid-run -- one honest retry with a fresh one
    const fresh = await getToken();
    res = await fetch(url, { headers: { Authorization: `Bearer ${fresh}` } });
  }
  if (!res.ok) throw new Error(`blob ${digest}: HTTP ${res.status} ${res.statusText}`);
  if (!res.body) throw new Error(`blob ${digest}: empty response body`);
  await pipeline(Readable.fromWeb(res.body), fs.createWriteStream(dest));
}

// Whiteout application -- TWO passes around the extraction, per the OCI
// image spec's actual ordering:
//   PRE-extraction (this function): .wh.<name> deletes <name> and
//   .wh..wh..opq clears the directory's children as they stood in the LOWER
//   layers -- the current layer's own files must survive, so deletions must
//   land BEFORE `tar -x` writes them.
//   POST-extraction (removeWhiteoutMarkers): tar materializes the marker
//   files themselves as regular files; they get unlinked afterwards.
// entries are the tar-listed paths of the CURRENT layer.
export function applyWhiteouts(rootfs, entries) {
  const applied = [];
  for (const entry of entries) {
    const name = path.posix.basename(entry);
    const kind = whiteoutKind(name);
    if (!kind) continue;
    const dir = path.posix.dirname(entry); // '.' at the layer root
    const dirPath = dir === '.' ? rootfs : path.join(rootfs, dir);
    if (kind === 'opaque') {
      let children = [];
      try {
        children = fs.readdirSync(dirPath);
      } catch {
        // directory itself does not exist -- nothing to clear
      }
      for (const child of children) {
        fs.rmSync(path.join(dirPath, child), { recursive: true, force: true });
      }
      applied.push(`opaque ${dir === '.' ? '/' : dir}`);
    } else {
      const target = path.join(dirPath, name.slice(4));
      fs.rmSync(target, { recursive: true, force: true });
      applied.push(`delete ${path.posix.join(dir, name.slice(4))}`);
    }
  }
  return applied;
}

// POST-extraction pass: the marker files tar just wrote are not content.
export function removeWhiteoutMarkers(rootfs, entries) {
  for (const entry of entries) {
    if (!whiteoutKind(path.posix.basename(entry))) continue;
    fs.rmSync(path.join(rootfs, entry), { force: true });
  }
}

function runTar(args, cwd) {
  const r = spawnSync('tar', args, { cwd, encoding: 'utf8' });
  if (r.status === 0) return r.stdout || '';
  const stderr = r.stderr || '';
  // Non-root extraction cannot mknod device nodes some base images carry;
  // tar still extracts every regular file and exits non-zero. Distinguish
  // that known-benign case from a real archive problem.
  if (/operation not permitted/i.test(stderr) && /mknod|device/i.test(stderr)) {
    process.stderr.write(`  (tar warned about device nodes -- expected as non-root; continuing)\n`);
    return r.stdout || '';
  }
  throw new Error(`tar ${args.join(' ')} exited ${r.status}: ${stderr.trim().split('\n')[0]}`);
}

function compileShim(shimSource, soDest) {
  const r = spawnSync('gcc', ['-shared', '-fPIC', '-O2', '-o', soDest, shimSource], {
    encoding: 'utf8',
  });
  if (r.status !== 0) {
    throw new Error(
      `gcc failed to build scripts/ldshim.c (exit ${r.status}): ${(r.stderr || '').trim()}\n` +
        `Fix: install gcc (the shim is only needed for 2.2.x tags -- ` +
        `fetch just the 2.4.x tags with --tags v2.4.6 if you cannot).`,
    );
  }
  return soDest;
}

function human(bytes) {
  const mb = bytes / (1024 * 1024);
  if (mb >= 1024) return `${(mb / 1024).toFixed(1)} GiB`;
  return `${mb.toFixed(1)} MiB`;
}

// Tag orchestration -------------------------------------------------------------

async function fetchTag(tag, opts, repoRoot) {
  const tagDir = path.resolve(repoRoot, opts.dir, tag);
  const rootfs = path.join(tagDir, 'rootfs');
  const layersDir = path.join(tagDir, 'layers');

  console.log(`\n=== ${tag} -> ${path.relative(repoRoot, tagDir)} ===`);
  let token = await getToken();
  let { mediaType, body } = await fetchManifest(token, tag);

  if (isIndexBody(body)) {
    const digest = selectPlatformManifest(body, opts.platform.os, opts.platform.arch);
    if (!digest) {
      throw new Error(
        `no ${opts.platform.os}/${opts.platform.arch} manifest for tag ${tag} ` +
          `(index media types: ${body.manifests.map((m) => `${m.platform?.os}/${m.platform?.architecture}`).join(', ')})`,
      );
    }
    console.log(`index -> ${opts.platform.os}/${opts.platform.arch} child ${digest.slice(7, 19)}...`);
    ({ mediaType, body } = await fetchManifest(token, digest));
  }

  const layers = Array.isArray(body.layers) ? body.layers : null;
  if (!layers) {
    throw new Error(
      `tag ${tag} resolved to ${mediaType || 'unknown media type'} with no layers[] -- ` +
        `old schema-v1 images are not supported; report the tag to docs/liquidsoap-upgrade.md owners`,
    );
  }

  fs.mkdirSync(layersDir, { recursive: true });
  fs.mkdirSync(rootfs, { recursive: true });

  let total = 0;
  for (const l of layers) total += Number(l.size || 0);
  console.log(`${layers.length} layers, ${human(total)} compressed total`);

  for (let i = 0; i < layers.length; i++) {
    const layer = layers[i];
    const dest = path.join(layersDir, `${String(i).padStart(2, '0')}_${layer.digest.replace(/[:/]/g, '_')}.tar`);
    const haveIt = fs.existsSync(dest) && fs.statSync(dest).size > 0;
    if (haveIt && !opts.force) {
      console.log(`  layer ${i + 1}/${layers.length}: cached (${human(fs.statSync(dest).size)})`);
    } else {
      console.log(
        `  layer ${i + 1}/${layers.length}: ${human(Number(layer.size || 0))} ${layer.digest.slice(7, 19)}...`,
      );
      await downloadBlob(token, layer.digest, dest);
    }

    if (layer.digest === EMPTY_LAYER_DIGEST || Number(layer.size || 0) === 0) {
      continue; // the OCI empty descriptor -- nothing to extract
    }

    const extractArgs = tarExtractArgs(layer.mediaType);
    const listArgs = tarListArgs(layer.mediaType);
    if (!extractArgs || !listArgs) {
      throw new Error(
        `layer ${i + 1} has unsupported media type "${layer.mediaType}" -- ` +
          `if this is a zstd layer, your tar needs zstd support (tar --zstd)`,
      );
    }

    const listing = runTar([...listArgs, dest]);
    const entries = listing.split('\n').map((s) => s.trim()).filter(Boolean);
    // OCI ordering: whiteouts act on the LOWER layers' content, so they must
    // be applied BEFORE this layer's files are extracted (an opaque marker
    // otherwise wipes the very files shipped beside it), and tar's own marker
    // files are dropped after the extraction.
    const whiteouts = applyWhiteouts(rootfs, entries);
    runTar([...extractArgs, dest, '-C', rootfs]);
    removeWhiteoutMarkers(rootfs, entries);
    for (const w of whiteouts) console.log(`    whiteout: ${w}`);
  }

  // Locate the engine + its own loader. Only REGULAR files count for the
  // loader (Debian's /lib64 entry is an absolute symlink to the host).
  const binRel = firstRegularFile(rootfs, binaryCandidates());
  if (!binRel) throw new Error(`no usr/bin/liquidsoap in the ${tag} image rootfs -- not a liquidsoap image?`);
  const loaderRel = firstRegularFile(rootfs, loaderCandidates());
  if (!loaderRel) throw new Error(`no usable ld-linux loader in the ${tag} image rootfs`);
  const libs = libraryDirs(rootfs);
  if (!libs.length) throw new Error(`no library directories in the ${tag} image rootfs`);

  const shim = needsShimForTag(tag);
  let stdlibRel = null;
  let shimSoRel = null;
  if (shim) {
    const shimSrc = path.join(repoRoot, 'scripts', 'ldshim.c');
    if (!fs.existsSync(shimSrc)) throw new Error(`missing ${shimSrc} -- the shim must ship with the tool`);
    shimSoRel = 'ldshim.so';
    compileShim(shimSrc, path.join(tagDir, shimSoRel));
    console.log(`shim: scripts/ldshim.c -> ${path.relative(repoRoot, path.join(tagDir, shimSoRel))}`);
  } else {
    stdlibRel = stdlibCandidates().find((rel) => fs.existsSync(path.join(rootfs, rel)));
    if (!stdlibRel) {
      throw new Error(
        `no stdlib.liq found under the ${tag} rootfs (looked in: ${stdlibCandidates().join(', ')})`,
      );
    }
    console.log(`stdlib: ${stdlibRel}`);
  }

  const runShPath = path.join(tagDir, 'run.sh');
  fs.writeFileSync(
    runShPath,
    buildRunSh({ tag, loaderRel, binRel, libDirs: libs, shim: shim ? shimSoRel : null, stdlibRel }),
    { mode: 0o755 },
  );
  fs.chmodSync(runShPath, 0o755);
  console.log(`wrapper: ${path.relative(repoRoot, runShPath)}`);

  if (opts.selfTest) {
    const r = spawnSync(runShPath, ['--version'], { encoding: 'utf8', timeout: 60_000 });
    if (r.status !== 0) {
      throw new Error(
        `self-test failed: run.sh --version exited ${r.status}\nstdout: ${r.stdout || '(none)'}\nstderr: ${r.stderr || '(none)'}`,
      );
    }
    const version = String(r.stdout || r.stderr || '').trim().split('\n')[0];
    console.log(`self-test: ${version || 'OK'}`);
  }
  return { tag, tagDir, runShPath };
}

async function main() {
  const argv = process.argv.slice(2);
  const opts = parseArgs(argv);
  if (opts.help) {
    console.log(HELP);
    return;
  }
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

  const results = [];
  for (const tag of opts.tags) {
    results.push(await fetchTag(tag, opts, repoRoot));
  }

  console.log('\nReady. Pre-flight --check against the REAL binaries (docs/liquidsoap-upgrade.md step 3):');
  console.log('  1) prepare a home dir whose config.json satisfies radio.liq\'s typed json.parse');
  console.log('     (dataDir, icecast{sourceHost,port,mount,sourcePassword,bitrate}, liquidsoap{telnetHost,telnetPort})');
  for (const { tag, runShPath } of results) {
    console.log(`  2) ${tag}:  cd liquidsoap && RADIOCLYDE_HOME=<home> ${path.relative(repoRoot, runShPath)} --check radio.liq`);
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  main().catch((err) => {
    console.error(`fetch-liquidsoap: ${err && err.message ? err.message : err}`);
    process.exit(1);
  });
}
