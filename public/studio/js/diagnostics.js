// Diagnostics (issue #2 B.1 + B.6): process/stream truth, playlist + metadata
// freshness, the process error ring, real log tails, and the repeat check.
// Everything here is measured server-side; failures render as failures.
import { api } from './api.js';

const el = (id) => document.getElementById(id);

function kv(label, value, cls = '') {
  const row = document.createElement('div');
  row.className = 'kv-row';
  const k = document.createElement('span');
  k.className = 'kv-key';
  k.textContent = label;
  const v = document.createElement('span');
  v.className = `kv-value ${cls}`;
  v.textContent = value;
  row.append(k, v);
  return row;
}

function fmtBytes(n) {
  if (!Number.isFinite(n)) return '—';
  const units = ['B', 'KB', 'MB', 'GB'];
  let v = n;
  let u = 0;
  while (v >= 1024 && u < units.length - 1) {
    v /= 1024;
    u += 1;
  }
  return `${v.toFixed(1)} ${units[u]}`;
}

function fmtWhen(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? String(iso) : d.toLocaleString('sl-SI');
}

function playlistKv(container, name, stats) {
  container.append(
    kv(
      name,
      stats.exists ? `${stats.entries} entries · updated ${fmtWhen(stats.mtime)} · ${fmtBytes(stats.sizeBytes)}` : 'missing',
      stats.exists ? '' : 'bad'
    )
  );
}

export async function loadDiagnostics() {
  const d = await api('/api/diagnostics');

  el('diag-process').replaceChildren(
    kv('PID', String(d.process.pid)),
    kv('Node', d.process.nodeVersion),
    kv('Uptime', `${Math.floor(d.process.uptimeSec / 3600)}h ${Math.floor((d.process.uptimeSec % 3600) / 60)}m`),
    kv('Memory RSS', fmtBytes(d.process.rssBytes)),
    kv('Heap used', fmtBytes(d.process.heapUsedBytes)),
    kv('Platform', d.process.platform)
  );

  const ice = d.stream.icecast;
  const streamBlock = el('diag-stream');
  streamBlock.replaceChildren(
    kv('Icecast reachable', ice.reachable ? 'yes' : 'NO', ice.reachable ? 'ok' : 'bad'),
    kv('Icecast healthy', ice.reachable && ice.healthy ? 'yes' : 'no / unknown'),
    kv('Listeners', ice.listeners === null || ice.listeners === undefined ? 'unknown (no stats answer)' : String(ice.listeners)),
    kv('Mount', d.stream.mount),
    kv('Public port', String(d.stream.publicPort)),
    ...(ice.error ? [kv('Probe error', ice.error, 'bad')] : [])
  );

  const pl = el('diag-playlists');
  pl.replaceChildren();
  playlistKv(pl, 'now_playing.m3u', d.station.playlists.nowPlaying);
  playlistKv(pl, 'filler.m3u', d.station.playlists.filler);
  pl.append(
    kv('Last metadata update (now_playing_track.json)', fmtWhen(d.station.lastMetadataUpdate)),
    kv('Template says on air', d.station.templateCurrent ? `${d.station.templateCurrent.id} (${d.station.templateCurrent.weekday} ${d.station.templateCurrent.startTime})` : '—'),
    kv('Downtime window', d.station.downtime ? `${d.station.downtime.start} – ${d.station.downtime.end}` : 'none'),
    kv('Timezone', d.station.timezone ?? '—')
  );
  if (d.station.nowPlaying?.track?.title) {
    pl.append(kv('Now playing (real)', `${d.station.nowPlaying.track.artist} — ${d.station.nowPlaying.track.title}`, 'accent'));
  } else if (d.station.nowPlaying?.dj) {
    pl.append(kv('Now playing (real)', `${d.station.nowPlaying.dj} (spoken segment)`, 'accent'));
  } else {
    pl.append(kv('Now playing (real)', 'nothing aired yet', 'warn'));
  }

  const rep = el('diag-repeats');
  rep.replaceChildren(
    kv('Rotation window', `${d.repeats.windowHours} h`),
    kv('Tracks repeated 2+ times', String(d.repeats.offenders.length), d.repeats.offenders.length ? 'bad' : 'ok')
  );
  for (const o of d.repeats.offenders.slice(0, 8)) {
    rep.append(kv(`${o.artist} — ${o.title}`, `${o.count}×, last ${fmtWhen(o.lastPlayedAt)}`, 'bad'));
  }

  const errors = d.errors ?? [];
  el('diag-errors').replaceChildren(
    ...errors.map((e) => {
      const li = document.createElement('li');
      li.textContent = `${fmtWhen(e.at)} [${e.source}] ${e.message}`;
      li.title = e.stack ?? '';
      return li;
    })
  );
  el('diag-errors-empty').hidden = errors.length > 0;

  const logs = el('diag-logs');
  logs.replaceChildren();
  for (const [name, lines] of Object.entries(d.logs ?? {})) {
    const h = document.createElement('h3');
    h.textContent = `${name} (last ${lines.length} lines)`;
    const pre = document.createElement('pre');
    pre.className = 'log-tail';
    pre.textContent = lines.join('\n');
    logs.append(h, pre);
  }
  if (!Object.keys(d.logs ?? {}).length) {
    const p = document.createElement('p');
    p.className = 'empty-note';
    p.textContent = 'No log lines yet (fresh deploy or empty logs).';
    logs.appendChild(p);
  }
}

export function startDiagnosticsView() {
  loadDiagnostics();
  // A monitoring view should stay current while it's open.
  if (!startDiagnosticsView._t) startDiagnosticsView._t = setInterval(loadDiagnostics, 15000);
}
