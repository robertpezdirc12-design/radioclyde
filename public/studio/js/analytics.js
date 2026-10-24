// Analytics view: audience time-series + per-track impact, straight from
// /api/analytics. No chart library -- a hand-built SVG polyline (zero new
// npm dependencies) that BREAKS the line on null buckets, so an Icecast
// outage or a station hole renders as a real gap, never a straight line
// drawn across it. Every empty state names its reason.
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

function fmtWhen(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? String(iso) : d.toLocaleString('sl-SI');
}

function fmtHM(iso) {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleTimeString('sl-SI', { hour: '2-digit', minute: '2-digit' });
}

function deltaCell(delta) {
  const td = document.createElement('td');
  const text = delta > 0 ? `+${delta}` : String(delta);
  td.textContent = text;
  td.className = delta > 0 ? 'delta-pos' : delta < 0 ? 'delta-neg' : '';
  return td;
}

function renderChart(container, series) {
  const pts = series.buckets;
  const W = 960;
  const H = 240;
  const padL = 40;
  const padR = 10;
  const padT = 10;
  const padB = 24;
  const innerW = W - padL - padR;
  const innerH = H - padT - padB;
  const maxVal = Math.max(1, ...pts.map((b) => b.listeners ?? 0));
  const x = (i) => padL + (pts.length <= 1 ? innerW / 2 : (i / (pts.length - 1)) * innerW);
  const y = (v) => padT + innerH - (v / maxVal) * innerH;

  const parts = [`<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Graf števila poslušalcev skozi čas">`];
  // Horizontal gridlines at 0, mid and max -- real ticks with labels.
  for (const v of [0, maxVal / 2, maxVal]) {
    const label = Number.isInteger(v) ? String(v) : v.toFixed(1);
    parts.push(
      `<line x1="${padL}" y1="${y(v).toFixed(1)}" x2="${W - padR}" y2="${y(v).toFixed(1)}" stroke="var(--border)" stroke-width="1"/>`,
      `<text x="${padL - 6}" y="${(y(v) + 4).toFixed(1)}" text-anchor="end" font-size="11" fill="var(--muted)">${label}</text>`
    );
  }
  // The line, segmented at gaps: a null bucket ends the current path.
  const segments = [];
  let d = '';
  let open = false;
  pts.forEach((b, i) => {
    if (b.listeners === null) {
      if (open) {
        segments.push(d);
        d = '';
        open = false;
      }
      return;
    }
    d += `${open ? ' L' : ' M'}${x(i).toFixed(1)},${y(b.listeners).toFixed(1)}`;
    open = true;
  });
  if (open) segments.push(d);
  for (const seg of segments) {
    parts.push(`<path d="${seg}" fill="none" stroke="var(--accent)" stroke-width="2" stroke-linejoin="round"/>`);
  }
  // 5 time ticks along the bottom.
  for (let t = 0; t < 5; t++) {
    const i = Math.round((t * (pts.length - 1)) / 4);
    parts.push(
      `<text x="${x(i).toFixed(1)}" y="${H - 6}" text-anchor="middle" font-size="11" fill="var(--muted)">${fmtHM(pts[i].ts)}</text>`
    );
  }
  parts.push('</svg>');
  container.innerHTML = parts.join('');
}

function chartEmptyReason(data) {
  const { series, ledger } = data;
  if (ledger.samples === 0) {
    return 'No samples yet -- the sampler runs once a minute and needs Icecast to answer at least once. This view fills in as the station runs.';
  }
  if (series.buckets.every((b) => b.listeners === null)) {
    return `All ${series.gaps} sample(s) in this window are gaps (Icecast not answering). Fix the stream first -- the chart shows nothing rather than inventing a line.`;
  }
  return null;
}

function renderSummary(data) {
  const s = el('analytics-summary');
  const cur = data.current;
  const curValue =
    cur.reachable && cur.healthy && cur.listeners !== null && cur.listeners !== undefined
      ? String(cur.listeners)
      : 'unknown (Icecast not answering)';
  s.replaceChildren(
    kv('Now (live probe)', curValue, cur.reachable && cur.healthy ? 'ok' : 'bad'),
    kv('Peak in window', data.peak !== null && data.peak !== undefined ? String(data.peak) : 'no valid sample in window',
      data.peak !== null && data.peak !== undefined ? 'ok' : 'warn'),
    kv('Peak (ledger lifetime)', data.peakAllTime !== null && data.peakAllTime !== undefined
      ? String(data.peakAllTime)
      : 'none yet',
      data.peakAllTime !== null && data.peakAllTime !== undefined ? 'ok' : 'warn'),
    kv('Samples in ledger', String(data.ledger.samples)),
    kv('Of which gaps', String(data.ledger.gapSamples), data.ledger.gapSamples > 0 ? 'warn' : 'ok'),
    kv('Oldest sample', fmtWhen(data.ledger.oldestTs)),
    kv('Newest sample', fmtWhen(data.ledger.newestTs)),
    kv('Sampling cadence', `${data.sampler.intervalMinutes} min`),
    kv('Ledger cap', `${data.sampler.maxEntries} entries (${data.sampler.ledgerPath})`)
  );

  const m = el('analytics-method');
  m.replaceChildren(
    kv('Impact window', `${data.impact.windowHours} h`),
    kv('Min samples per play', String(data.impact.minSamples)),
    kv('Min time coverage', `${Math.round(data.impact.minCoverage * 100)}% of the track`),
    kv('Tracks measured', String(data.impact.measuredTracks), data.impact.measuredTracks ? 'ok' : 'warn'),
    kv('Plays unmeasurable', String(
      data.impact.skipped.noDuration + data.impact.skipped.noData + data.impact.skipped.tooFewSamples + data.impact.skipped.thinCoverage
    ))
  );
}

function renderImpact(data) {
  const body = el('impact-table-body');
  const empty = el('impact-empty');
  const skippedNote = el('impact-skipped');
  const rows = data.impact.measured.slice(0, 20);
  body.replaceChildren(
    ...rows.map((t) => {
      const tr = document.createElement('tr');
      const name = document.createElement('td');
      name.textContent = t.artist ? `${t.artist} — ${t.title}` : t.title;
      const plays = document.createElement('td');
      plays.textContent = String(t.plays);
      const avg = document.createElement('td');
      avg.textContent = String(t.listenersAvg);
      const delta = deltaCell(t.avgDelta);
      const last = document.createElement('td');
      last.textContent = fmtWhen(t.lastMeasuredAt);
      tr.append(name, plays, avg, delta, last);
      return tr;
    })
  );
  empty.hidden = rows.length > 0;
  if (!rows.length) {
    empty.textContent =
      'No track impact measured yet. A play becomes measurable only when at least ' +
      `${data.impact.minSamples} Icecast samples cover ${Math.round(data.impact.minCoverage * 100)}% of its duration. ` +
      'This fills in as the sampler and the station run together.';
  }
  const sk = data.impact.skipped;
  const total = sk.noDuration + sk.noData + sk.tooFewSamples + sk.thinCoverage;
  skippedNote.hidden = total === 0;
  if (total > 0) {
    skippedNote.textContent =
      `Unmeasurable plays (counted, never hidden): ${sk.noDuration} without duration, ` +
      `${sk.noData} during Icecast outages, ${sk.tooFewSamples} with too few samples, ` +
      `${sk.thinCoverage} with too little time coverage.`;
  }
}

async function loadAnalytics() {
  const hours = Number(el('analytics-range').value) || 24;
  const data = await api(`/api/analytics?hours=${hours}`);
  renderSummary(data);
  renderImpact(data);
  const chartBox = el('analytics-chart');
  const chartEmpty = el('analytics-chart-empty');
  const reason = chartEmptyReason(data);
  if (reason) {
    chartBox.replaceChildren();
    chartEmpty.textContent = reason;
    chartEmpty.hidden = false;
  } else {
    chartEmpty.hidden = true;
    renderChart(chartBox, data.series);
  }
}

// app.js re-runs startAnalyticsView() on every visit to this tab -- bind the
// DOM listeners once so N visits don't fire N identical requests per click.
let bound = false;

export function startAnalyticsView() {
  if (!bound) {
    bound = true;
    el('analytics-refresh').addEventListener('click', () => loadAnalytics());
    el('analytics-range').addEventListener('change', () => loadAnalytics());
  }
  loadAnalytics();
}
