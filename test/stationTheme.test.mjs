// Station-wide default theme (themes.default) regression tests -- Val 16.
//
// The listener shell (public/index.html) is served by an explicit route in
// src/server/staticFiles.js. When config.themes.default names a real theme,
// the server stamps it on exactly two tokens before serving: the
// <html data-station-default="..."> attribute the constants-only pre-paint
// script reads, and the first-paint <meta name="theme-color">. Everything
// else about theming stays per-listener (localStorage choice always wins).
//
// Same honesty standards as the rest of the repo:
// - no themes block and an invalid value both degrade to Klasika -- a
//   missing/typo'd config can never break the shell (the F2 lesson);
// - the injection is pinned BYTE-EXACTLY: an explicit substring assert
//   catches token drift loudly, a full-body equality proves nothing else
//   changed, and embed.html / app.js are proven untouched;
// - the pre-paint precedence contract (saved choice > station default >
//   Klasika, invalid anything falls back) is executed against the REAL
//   inline script text extracted from the REAL served body, in a VM;
// - the four copies of the theme id list (style.css blocks, app.js THEMES,
//   the script's IDS literal, staticFiles STATION_THEME_IDS) are pinned
//   against each other so they cannot drift apart silently.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import Fastify from 'fastify';

import { setupTestConfig, repoRoot } from './fixtures.mjs';

// No themes block in the fixture config -- Klasika is the documented default.
setupTestConfig('station-theme', {});

const { registerStaticRoutes } = await import('../src/server/staticFiles.js');
const { config: liveConfig } = await import('../src/config/index.js');

const shellFile = () => fs.readFileSync(path.join(repoRoot(), 'public', 'index.html'), 'utf8');

async function get(pathname) {
  const fastify = Fastify({ logger: false });
  registerStaticRoutes(fastify);
  try {
    return await fastify.inject({ method: 'GET', url: pathname });
  } finally {
    await fastify.close();
  }
}

describe('station theme injection on the listener shell', () => {
  test('no themes block -> shell served byte-identical (Klasika fast path)', async () => {
    const res = await get('/');
    assert.equal(res.statusCode, 200);
    assert.equal(res.headers['content-type'], 'text/html');
    assert.equal(res.headers['cache-control'], 'no-store');
    // The two file-side tokens, pinned as they ship (also the injection
    // targets -- if either drifts in public/index.html, this fails loudly
    // instead of the replace silently becoming a no-op).
    assert.match(res.body, /<html lang="sl" data-station-default="klasika">/);
    assert.match(res.body, /<meta name="theme-color" content="#0a0c12">/);
    assert.equal(res.body, shellFile());
  });

  test('themes.default "vinil" -> exactly the two stamps change, nothing else', async () => {
    liveConfig.themes = { default: 'vinil' };
    try {
      const res = await get('/');
      assert.equal(res.statusCode, 200);
      // Load-bearing asserts: the stamps are actually IN the served body.
      assert.match(res.body, /<html lang="sl" data-station-default="vinil">/);
      assert.match(res.body, /<meta name="theme-color" content="#17120e">/);
      // And nothing else changed -- the served body is the file with exactly
      // those two substitutions.
      const expected = shellFile()
        .replace('data-station-default="klasika"', 'data-station-default="vinil"')
        .replace('<meta name="theme-color" content="#0a0c12">', '<meta name="theme-color" content="#17120e">');
      assert.equal(res.body, expected);
    } finally {
      delete liveConfig.themes;
    }
  });

  test('every other valid id stamps its own attribute + first-paint bg', async () => {
    const bgs = { jutro: '#f7f3ec', terminal: '#060a07' };
    for (const id of Object.keys(bgs)) {
      liveConfig.themes = { default: id };
      try {
        const res = await get('/');
        assert.match(res.body, new RegExp(`<html lang="sl" data-station-default="${id}">`));
        assert.match(res.body, new RegExp(`<meta name="theme-color" content="${bgs[id]}">`));
        const expected = shellFile()
          .replace('data-station-default="klasika"', `data-station-default="${id}"`)
          .replace('<meta name="theme-color" content="#0a0c12">', `<meta name="theme-color" content="${bgs[id]}">`);
        assert.equal(res.body, expected, `${id}: only the two stamps differ`);
      } finally {
        delete liveConfig.themes;
      }
    }
  });

  test('invalid id -> honest Klasika + exactly ONE warning per process', async () => {
    const warns = [];
    const origWarn = console.warn;
    console.warn = (...args) => warns.push(args.join(' '));
    liveConfig.themes = { default: 'ne-obstaja' };
    try {
      const first = await get('/');
      const second = await get('/');
      assert.match(first.body, /<html lang="sl" data-station-default="klasika">/);
      assert.match(first.body, /<meta name="theme-color" content="#0a0c12">/);
      assert.equal(first.body, shellFile(), 'no mutation on the degraded path either');
      assert.equal(second.statusCode, 200, 'warn-once is about noise, not about serving');
      const themeWarns = warns.filter((w) => w.includes('ni veljavna tema'));
      assert.equal(themeWarns.length, 1, 'one honest warning, not one per request');
      assert.match(themeWarns[0], /ne-obstaja/);
    } finally {
      console.warn = origWarn;
      delete liveConfig.themes;
    }
  });

  test('non-string default -> Klasika, no crash (guard, not throw)', async () => {
    liveConfig.themes = { default: 5 };
    try {
      const res = await get('/');
      assert.equal(res.statusCode, 200);
      assert.match(res.body, /<html lang="sl" data-station-default="klasika">/);
      assert.equal(res.body, shellFile());
    } finally {
      delete liveConfig.themes;
    }
  });

  test('embed.html and app.js stay byte-identical under a non-Klasika default', async () => {
    liveConfig.themes = { default: 'vinil' };
    try {
      const embed = await get('/embed.html');
      const appjs = await get('/app.js');
      assert.equal(embed.statusCode, 200);
      assert.equal(appjs.statusCode, 200);
      assert.equal(embed.body, fs.readFileSync(path.join(repoRoot(), 'public', 'embed.html'), 'utf8'));
      assert.equal(appjs.body, fs.readFileSync(path.join(repoRoot(), 'public', 'app.js'), 'utf8'));
      assert.doesNotMatch(embed.body, /data-station-default/, 'embed stays self-contained and unthemed');
    } finally {
      delete liveConfig.themes;
    }
  });
});

describe('pre-paint precedence contract (real script, real served body)', () => {
  // Extract the constants-only inline script from a served shell. It is the
  // FIRST <script> in index.html and the only inline one (app.js is a src).
  function prepaintScriptFrom(html) {
    const match = html.match(/<script>([\s\S]*?)<\/script>/);
    assert.ok(match, 'inline pre-paint script present');
    assert.match(match[1], /radioclyde-theme/, 'the right script (theme key)');
    return match[1];
  }

  // Run the REAL script text in a VM against a mocked document/localStorage.
  function runPrepaint(script, { stationDefault, saved, storageThrows } = {}) {
    const dataset = {};
    if (stationDefault !== undefined) dataset.stationDefault = stationDefault;
    const sandbox = {
      document: { documentElement: { dataset } },
      localStorage: {
        getItem: () => {
          if (storageThrows) throw new Error('storage blocked');
          return saved ?? null;
        },
      },
    };
    vm.runInContext(script, vm.createContext(sandbox));
    return sandbox.document.documentElement.dataset.theme;
  }

  test('the injected attribute reaches the script; the script itself is never rewritten', async () => {
    const klasikaScript = prepaintScriptFrom(shellFile());
    liveConfig.themes = { default: 'vinil' };
    let vinilScript;
    try {
      vinilScript = prepaintScriptFrom((await get('/')).body);
    } finally {
      delete liveConfig.themes;
    }
    assert.equal(vinilScript, klasikaScript, 'injection touches the attribute/meta, never the script text');
    return vinilScript;
  });

  test('precedence: saved choice > station default > Klasika', async () => {
    const script = prepaintScriptFrom(shellFile());
    assert.equal(runPrepaint(script, { stationDefault: 'vinil', saved: 'jutro' }), 'jutro');
    assert.equal(runPrepaint(script, { stationDefault: 'vinil', saved: null }), 'vinil');
    assert.equal(runPrepaint(script, { stationDefault: 'vinil', saved: '' }), 'vinil', 'empty saved value is not a choice');
    assert.equal(runPrepaint(script, { stationDefault: undefined, saved: null }), 'klasika');
  });

  test('stale or tampered saved value falls back to the station default', async () => {
    const script = prepaintScriptFrom(shellFile());
    assert.equal(runPrepaint(script, { stationDefault: 'vinil', saved: 'ne-obstaja' }), 'vinil');
    assert.equal(runPrepaint(script, { stationDefault: 'klasika', saved: 'ne-obstaja' }), 'klasika');
  });

  test('blocked storage (private mode) -> station default, never a crash', async () => {
    const script = prepaintScriptFrom(shellFile());
    assert.equal(runPrepaint(script, { stationDefault: 'jutro', storageThrows: true }), 'jutro');
    assert.equal(runPrepaint(script, { stationDefault: undefined, storageThrows: true }), 'klasika');
  });

  test('an invalid stamped station default degrades to Klasika (defense in depth)', async () => {
    const script = prepaintScriptFrom(shellFile());
    // Cannot happen through the server (it validates), but the script must
    // hold the line on its own -- a hand-edited file or a future bug must
    // never load an unknown skin.
    assert.equal(runPrepaint(script, { stationDefault: 'xxx' }), 'klasika');
    assert.equal(runPrepaint(script, { stationDefault: '' }), 'klasika');
  });

  test('the theme id list stays in sync across all four copies', () => {
    const script = prepaintScriptFrom(shellFile());
    const appjs = fs.readFileSync(path.join(repoRoot(), 'public', 'app.js'), 'utf8');
    const css = fs.readFileSync(path.join(repoRoot(), 'public', 'style.css'), 'utf8');
    const serverSrc = fs.readFileSync(path.join(repoRoot(), 'src', 'server', 'staticFiles.js'), 'utf8');
    const ids = ['klasika', 'jutro', 'vinil', 'terminal'];

    assert.ok(script.includes("var IDS = ['klasika', 'jutro', 'vinil', 'terminal'];"), 'pre-paint IDS literal');
    assert.ok(
      serverSrc.includes("const STATION_THEME_IDS = ['klasika', 'jutro', 'vinil', 'terminal'];"),
      'server-side id list'
    );
    assert.ok(
      serverSrc.includes(
        "const THEME_BG = { klasika: '#0a0c12', jutro: '#f7f3ec', vinil: '#17120e', terminal: '#060a07' };"
      ),
      'server-side bg pairing'
    );
    for (const id of ids) {
      const label = id[0].toUpperCase() + id.slice(1);
      assert.ok(appjs.includes(`${id}: { label: '${label}', bg: `), `app.js THEMES has ${id}`);
      assert.ok(css.includes(`[data-theme="${id}"]`), `style.css has the ${id} skin block`);
    }
  });
});
