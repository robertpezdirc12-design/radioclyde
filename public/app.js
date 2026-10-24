// Radio Markec listener app -- Slovenian, deterministic-data only (issue #2).
// Every value shown comes from a real endpoint; every fetch failure or empty
// result renders an explicit state instead of a fake one. Favourites are
// localStorage-only and SAY so -- the backend has no listener accounts.

const POLL_MS = 12000;
const SCHEDULE_POLL_MS = 5 * 60 * 1000;

const $ = (id) => document.getElementById(id);

const player = $('player');
const els = {
  logo: $('logo'),
  brandName: $('brand-name'),
  liveChip: $('live-chip'),
  weatherChip: $('weather-chip'),
  listenersChip: $('listeners-chip'),
  art: $('art'),
  artFallback: $('art-fallback'),
  onAirLabel: $('on-air-label'),
  trackTitle: $('track-title'),
  trackArtist: $('track-artist'),
  djTalking: $('dj-talking'),
  progress: $('track-progress'),
  progressFill: $('track-progress-fill'),
  elapsed: $('track-elapsed'),
  duration: $('track-duration'),
  playButton: $('play-button'),
  muteButton: $('mute-button'),
  volume: $('volume-slider'),
  likeButton: $('like-button'),
  status: $('player-status'),
  historyList: $('history-list'),
  historyEmpty: $('history-empty'),
  historyError: $('history-error'),
  upcomingList: $('upcoming-list'),
  upcomingEmpty: $('upcoming-empty'),
  upcomingError: $('upcoming-error'),
  favList: $('fav-list'),
  favEmpty: $('fav-empty'),
  pushButton: $('push-button'),
  pushStatus: $('push-status'),
  weekGrid: $('week-grid'),
  scheduleTz: $('schedule-tz'),
  topList: $('top-list'),
  topEmpty: $('top-empty'),
  topError: $('top-error'),
  topWindow: $('top-window'),
  podList: $('pod-list'),
  podError: $('pod-error'),
  podRss: $('pod-rss'),
  podRssCopy: $('pod-rss-copy'),
  scheduleError: $('schedule-error'),
  downtimeNote: $('downtime-note'),
  form: $('request-form'),
  reqResult: $('req-result'),
  reqChips: $('req-chips'),
  checkButton: $('req-check'),
  checkInput: $('req-check-id'),
  checkResult: $('req-status'),
};

const SL_DAYS = { monday: 'Ponedeljek', tuesday: 'Torek', wednesday: 'Sreda', thursday: 'Četrtek', friday: 'Petek', saturday: 'Sobota', sunday: 'Nedelja' };

let streamStarted = false;
let trackIsPlaying = false;
let currentTrackTiming = null; // { playedAt epoch ms, durationMs } -- ticked client-side between polls
let currentTrackKey = null; // "artist\n=title" like-key of the airing track
// Inputs for the deterministic request-form chips: the currently airing
// track plus the unique artists of the last history fetch. Both come from
// data the page already polls -- no extra requests, no randomness.
let chipCurrent = null; // { artist, title }
let chipRecentArtists = []; // unique, newest-first, capped

// ---------- helpers ----------

function formatClock(ms) {
  const total = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}

function formatWhen(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleString('sl-SI', { weekday: 'short', hour: '2-digit', minute: '2-digit' });
}

function setStatus(text, cls = '') {
  els.status.textContent = text;
  els.status.className = `player-status ${cls}`;
}

function show(node, yes) {
  node.hidden = !yes;
}

// ---------- favourites (localStorage, honest) ----------

const FAV_KEY = 'radioclyde-favourites';

function readFavs() {
  try {
    const parsed = JSON.parse(localStorage.getItem(FAV_KEY) ?? '[]');
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function writeFavs(favs) {
  try {
    localStorage.setItem(FAV_KEY, JSON.stringify(favs.slice(0, 200)));
  } catch {
    // private mode / storage full -- favourites are a convenience, never critical
  }
}

function trackKey(artist, title) {
  return `${(artist ?? '').trim()} — ${(title ?? '').trim()}`;
}

function isFav(artist, title) {
  return readFavs().some((f) => f.key === trackKey(artist, title));
}

function toggleFav(artist, title) {
  if (!(title ?? '').trim()) return;
  const key = trackKey(artist, title);
  const favs = readFavs();
  const idx = favs.findIndex((f) => f.key === key);
  if (idx === -1) favs.unshift({ key, artist: artist ?? '', title: title ?? '', at: new Date().toISOString() });
  else favs.splice(idx, 1);
  writeFavs(favs);
  renderFavs();
  syncLikeButtons();
}

function syncLikeButtons() {
  const liked = currentTrackKey ? isFav(...currentTrackKey.split(' — ')) : false;
  els.likeButton.setAttribute('aria-pressed', String(liked));
  els.likeButton.title = liked ? 'Odstrani iz priljubljenih (lokalno)' : 'Shrani skladbo med priljubljene (lokalno v brskalniku)';
}

// ---------- MediaSession (lock-screen / headphone controls) ----------
//
// Radio semantics, deliberate: play/pause/stop are wired, next/previous and
// seek are NOT -- a stray double-tap on someone's headphones must not change
// what the WHOLE shared stream is playing (same constraint SUB/WAVE
// documents for its web player; one stream, one playlist, no per-listener
// control). Metadata (title/artist/artwork) follows whatever /api/now-
// playing reports, including the spoken-segment branch (show name + DJ).
function updateMediaSession({ title, artist, album, artUrl }) {
  if (!('mediaSession' in navigator)) return;
  try {
    navigator.mediaSession.metadata = new MediaMetadata({
      title: title || 'Radio Markec',
      artist: artist || '',
      album: album || 'Radio Markec',
      artwork: [
        { src: new URL(artUrl || '/logo.png', location.href).href, sizes: '512x512', type: artUrl ? 'image/jpeg' : 'image/png' },
      ],
    });
  } catch { /* metadata is cosmetic -- never break playback over it */ }
}

function clearMediaSession() {
  updateMediaSession({ title: 'Radio Markec', artist: '', album: '', artUrl: null });
  if ('mediaSession' in navigator) {
    try { navigator.mediaSession.playbackState = 'paused'; } catch { /* ignore */ }
  }
}

// ---------- deterministic request-form chips ----------

function chipButton(label, fill) {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'chip-btn';
  b.textContent = label;
  b.addEventListener('click', () => {
    fill();
    $('req-title').focus();
  });
  return b;
}

function renderChips() {
  const chips = [];
  if (chipCurrent?.title) {
    chips.push(
      chipButton(`Posvetilo: ${chipCurrent.title}`, () => {
        $('req-type').value = 'dedication';
        $('req-title').value = chipCurrent.title;
        $('req-artist').value = chipCurrent.artist ?? '';
      })
    );
    if (chipCurrent.artist) {
      chips.push(
        chipButton(`Še kaj od ${chipCurrent.artist}`, () => {
          $('req-type').value = 'request';
          $('req-artist').value = chipCurrent.artist;
          $('req-title').value = '';
        })
      );
    }
  }
  for (const artist of chipRecentArtists) {
    chips.push(
      chipButton(artist, () => {
        $('req-type').value = 'request';
        $('req-artist').value = artist;
        $('req-title').value = '';
      })
    );
  }
  els.reqChips.replaceChildren(...chips);
  els.reqChips.hidden = chips.length === 0;
}

function favRow(f) {
  const li = document.createElement('li');
  const text = document.createElement('div');
  text.className = 'row-text';
  const main = document.createElement('p');
  main.className = 'row-main';
  main.textContent = f.title;
  const sub = document.createElement('p');
  sub.className = 'row-sub';
  sub.textContent = f.artist || 'neznan izvajalec';
  text.append(main, sub);
  const del = document.createElement('button');
  del.className = 'row-like';
  del.type = 'button';
  del.setAttribute('aria-pressed', 'true');
  del.setAttribute('aria-label', `Odstrani ${f.title} iz priljubljenih`);
  del.innerHTML = '<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path fill="currentColor" d="m12 21-1.45-1.32C5.4 15.36 2 12.28 2 8.5 2 5.42 4.42 3 7.5 3c1.74 0 3.41.81 4.5 2.09C13.09 3.81 14.76 3 16.5 3 19.58 3 22 5.42 22 8.5c0 3.78-3.4 6.86-8.55 11.18L12 21Z"/></svg>';
  del.addEventListener('click', () => toggleFav(f.artist, f.title));
  li.append(text, del);
  return li;
}

function renderFavs() {
  const favs = readFavs();
  els.favList.replaceChildren(...favs.map(favRow));
  show(els.favEmpty, favs.length === 0);
}

// ---------- now playing ----------

function renderNowPlaying(data) {
  if (data.station?.name) {
    document.title = data.station.name;
    els.brandName.textContent = data.station.name;
  }
  show(els.liveChip, Boolean(data.show || data.track || data.dj));

  if (data.dj) {
    els.djTalking.hidden = false;
    els.djTalking.textContent = `🎙 ${data.dj} govori`;
    els.trackTitle.textContent = data.show?.name ?? 'Govorjeni del';
    els.trackArtist.textContent = data.show?.host ? `z ${data.show.host}` : '';
    currentTrackTiming = null;
    trackIsPlaying = false;
    currentTrackKey = null;
    // Persona photo slot -- same lookup the old page used; missing photos hide themselves.
    const persona = data.dj.split(' & ')[0].toLowerCase();
    els.art.hidden = false;
    els.artFallback.hidden = true;
    els.art.src = `/dj-photos/${persona}`;
    chipCurrent = null; // spoken segment -- no track to build chips from
    updateMediaSession({ title: data.show?.name ?? 'Govorjeni del', artist: `${data.dj} govori`, album: '', artUrl: null });
  } else if (data.track?.title) {
    els.djTalking.hidden = true;
    els.trackTitle.textContent = data.track.title;
    els.trackArtist.textContent = data.track.artist ?? '';
    currentTrackKey = [data.track.artist, data.track.title];
    trackIsPlaying = true;
    currentTrackTiming =
      data.track.playedAt && data.track.durationMs
        ? { playedAt: new Date(data.track.playedAt).getTime(), durationMs: data.track.durationMs }
        : null;
    if (data.track.artUrl) {
      els.art.hidden = false;
      els.artFallback.hidden = true;
      els.art.src = data.track.artUrl;
    } else {
      els.art.hidden = true;
      els.artFallback.hidden = false;
    }
    chipCurrent = { artist: data.track.artist ?? '', title: data.track.title };
    updateMediaSession({
      title: data.track.title,
      artist: data.track.artist ?? '',
      album: data.track.album ?? '',
      artUrl: data.track.artUrl ?? null,
    });
  } else {
    els.djTalking.hidden = true;
    els.trackTitle.textContent = 'Nič ne oddaja';
    els.trackArtist.textContent = 'Postaja se je (še) zagnala -- čakamo prvi segment.';
    currentTrackTiming = null;
    trackIsPlaying = false;
    currentTrackKey = null;
    els.art.hidden = true;
    els.artFallback.hidden = false;
    chipCurrent = null;
    clearMediaSession();
  }
  syncLikeButtons();
  renderChips();
  tickProgress();
}

function tickProgress() {
  if (!currentTrackTiming) {
    show(els.progress, false);
    return;
  }
  const { playedAt, durationMs } = currentTrackTiming;
  const elapsed = Math.min(Date.now() - playedAt, durationMs);
  show(els.progress, true);
  els.progressFill.style.width = `${Math.min(100, (elapsed / durationMs) * 100)}%`;
  els.elapsed.textContent = formatClock(elapsed);
  els.duration.textContent = formatClock(durationMs);
}

async function fetchNowPlaying() {
  try {
    const res = await fetch('/api/now-playing');
    if (!res.ok) throw new Error(res.status);
    renderNowPlaying(await res.json());
  } catch {
    // Transient: keep last state, surface nothing scary on the very first load.
    if (!els.trackTitle.textContent.trim()) {
      els.trackTitle.textContent = 'Ni povezave s strežnikom';
      els.trackArtist.textContent = 'Podatkov o predvajanju trenutno ni mogoče naložiti.';
    }
  }
}

// ---------- history / upcoming ----------

function historyRow(entry) {
  const li = document.createElement('li');
  if (entry.artUrl) {
    const img = document.createElement('img');
    img.src = entry.artUrl;
    img.alt = '';
    img.loading = 'lazy';
    // /api/art 404s for tracks Plex has no cover for -- hide the broken
    // image rather than showing a torn frame.
    img.addEventListener('error', () => img.remove());
    li.appendChild(img);
  }
  const text = document.createElement('div');
  text.className = 'row-text';
  const main = document.createElement('p');
  main.className = 'row-main';
  main.textContent = entry.title;
  const sub = document.createElement('p');
  sub.className = 'row-sub';
  sub.textContent = entry.artist;
  text.append(main, sub);
  const time = document.createElement('span');
  time.className = 'row-time';
  time.textContent = formatWhen(entry.playedAt);
  const like = document.createElement('button');
  like.className = 'row-like';
  like.type = 'button';
  const liked = isFav(entry.artist, entry.title);
  like.setAttribute('aria-pressed', String(liked));
  like.setAttribute('aria-label', liked ? `Odstrani ${entry.title} iz priljubljenih` : `Shrani ${entry.title} med priljubljene`);
  like.innerHTML = '<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path fill="currentColor" d="m12 21-1.45-1.32C5.4 15.36 2 12.28 2 8.5 2 5.42 4.42 3 7.5 3c1.74 0 3.41.81 4.5 2.09C13.09 3.81 14.76 3 16.5 3 19.58 3 22 5.42 22 8.5c0 3.78-3.4 6.86-8.55 11.18L12 21Z"/></svg>';
  like.addEventListener('click', () => toggleFav(entry.artist, entry.title));
  li.append(text, time, like);
  return li;
}

async function fetchHistory() {
  try {
    const res = await fetch('/api/history?limit=20');
    if (!res.ok) throw new Error(res.status);
    const { entries } = await res.json();
    const display = trackIsPlaying ? entries.slice(1) : entries; // entries[0] duplicates the hero
    els.historyList.replaceChildren(...display.map(historyRow));
    show(els.historyEmpty, display.length === 0);
    show(els.historyError, false);
    // Chip pool: unique artists of the recent history, newest first, capped
    // at 3 -- deterministic inputs for the request form's suggestion chips.
    const seen = new Set();
    chipRecentArtists = [];
    for (const e of entries ?? []) {
      const artist = (e.artist ?? '').trim();
      if (!artist || seen.has(artist)) continue;
      seen.add(artist);
      chipRecentArtists.push(artist);
      if (chipRecentArtists.length === 3) break;
    }
    renderChips();
  } catch {
    show(els.historyError, true);
  }
}

function upcomingRow(show) {
  const li = document.createElement('li');
  const text = document.createElement('div');
  text.className = 'row-text';
  const main = document.createElement('p');
  main.className = 'row-main';
  main.textContent = show.name;
  const sub = document.createElement('p');
  sub.className = 'row-sub';
  sub.textContent = show.host ? `z ${show.host}` : '';
  text.append(main, sub);
  const when = document.createElement('span');
  when.className = 'row-time';
  const day = new Date(`${show.date}T${show.startTime}:00`);
  when.textContent = Number.isNaN(day.getTime())
    ? `${show.weekday} ${show.startTime}`
    : day.toLocaleString('sl-SI', { weekday: 'short', hour: '2-digit', minute: '2-digit' });
  li.append(text, when);
  return li;
}

async function fetchUpcoming() {
  try {
    const res = await fetch('/api/upcoming');
    if (!res.ok) throw new Error(res.status);
    const { shows } = await res.json();
    els.upcomingList.replaceChildren(...(shows ?? []).map(upcomingRow));
    show(els.upcomingEmpty, (shows ?? []).length === 0);
    show(els.upcomingError, false);
  } catch {
    show(els.upcomingError, true);
  }
}

// ---------- weather (real, optional) ----------
async function fetchWeather() {
  try {
    const res = await fetch('/api/weather');
    if (!res.ok) return;
    const w = await res.json();
    if (w?.temperatureC == null) return;
    els.weatherChip.textContent = `${Math.round(w.temperatureC)}°C, ${w.condition ?? ''}`;
    els.weatherChip.hidden = false;
  } catch {
    els.weatherChip.hidden = true; // optional feature failing silently is fine
  }
}

// ---------- live listener count (real, optional) ----------

// Slovenian pluralization done properly: 1 poslušalec, 2–4 poslušalca,
// 5+ poslušalcev (the 11/12/14 exceptions from Russian-style counts don't
// apply here, but the tens/teens rule does: 12 poslušalcev, 22 poslušalca).
function listenersLabel(n) {
  const mod100 = n % 100;
  if (n === 1) return '1 poslušalec';
  if (mod100 >= 2 && mod100 <= 4) return `${n} poslušalca`;
  return `${n} poslušalcev`;
}

async function fetchListeners() {
  try {
    const res = await fetch('/api/listeners');
    if (!res.ok) throw new Error(String(res.status));
    const data = await res.json();
    if (data?.listeners == null) throw new Error('no count');
    // "vrh 24 h" is the sampling ledger's peak, echoed by /api/listeners --
    // shown only when the ledger actually measured something, never invented.
    const peakPart =
      data.peak != null && data.peak !== data.listeners ? ` · vrh 24 h: ${listenersLabel(data.peak)}` : '';
    els.listenersChip.textContent = `${listenersLabel(data.listeners)}${peakPart}`;
    els.listenersChip.hidden = false;
  } catch {
    els.listenersChip.hidden = true; // dead/unreachable stream hides the chip -- never a stale number
  }
}

// ---------- schedule ----------

function renderSchedule(data) {
  els.scheduleTz.textContent = `Vsi časi veljajo za časovni pas ${data.timezone ?? 'neznan'}.`;
  const todayDate = data.days?.[0]?.date;
  els.weekGrid.replaceChildren(
    ...(data.days ?? []).map((day) => {
      const col = document.createElement('div');
      col.className = 'day-col' + (day.date === todayDate ? ' is-today' : '');
      const name = document.createElement('p');
      name.className = 'day-name';
      name.textContent = SL_DAYS[day.weekday] ?? day.weekday;
      const date = document.createElement('p');
      date.className = 'day-date';
      const d = new Date(`${day.date}T12:00:00`);
      date.textContent = Number.isNaN(d.getTime()) ? day.date : d.toLocaleDateString('sl-SI', { day: 'numeric', month: 'short' });
      col.append(name, date);
      for (const show of day.shows) {
        const item = document.createElement('div');
        item.className = 'show-item' + (show.mark ? ` mark-${show.mark}` : '');
        const time = document.createElement('span');
        time.className = 'show-time';
        time.textContent = show.startTime;
        if (show.mark === 'on-air') time.insertAdjacentHTML('beforeend', '<span class="mark-chip on-air">ZDAJ</span>');
        if (show.mark === 'next') time.insertAdjacentHTML('beforeend', '<span class="mark-chip next">NASLEDNJI</span>');
        const nameEl = document.createElement('p');
        nameEl.className = 'show-name';
        nameEl.textContent = show.name;
        item.append(time, nameEl);
        if (show.host) {
          const host = document.createElement('p');
          host.className = 'show-host';
          host.textContent = show.host;
          item.appendChild(host);
        }
        col.appendChild(item);
      }
      if (!day.shows.length) {
        const empty = document.createElement('p');
        empty.className = 'empty';
        empty.textContent = 'Brez oddaj';
        col.appendChild(empty);
      }
      return col;
    })
  );
  if (data.downtime?.start && data.downtime?.end) {
    els.downtimeNote.textContent = `Izven urnika (med ${data.downtime.start} in ${data.downtime.end}) postaja predvaja polnilni program.`;
    els.downtimeNote.hidden = false;
  }
  show(els.scheduleError, false);
}

async function fetchSchedule() {
  try {
    const res = await fetch('/api/schedule');
    if (!res.ok) throw new Error(res.status);
    renderSchedule(await res.json());
  } catch {
    show(els.scheduleError, true);
  }
}

// ---------- requests ----------

async function submitRequest(event) {
  event.preventDefault();
  const type = $('req-type').value;
  const title = $('req-title').value.trim();
  const artist = $('req-artist').value.trim();
  const message = $('req-message').value.trim();
  const from = $('req-from').value.trim();
  els.reqResult.className = 'form-result';
  els.reqResult.textContent = 'Pošiljam …';
  const button = els.form.querySelector('button[type="submit"]');
  button.disabled = true;
  try {
    const res = await fetch('/api/requests', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type, title, artist, message, from }),
    });
    const data = await res.json().catch(() => ({}));
    if (res.status === 201) {
      els.reqResult.className = 'form-result is-ok';
      els.reqResult.innerHTML = '';
      els.reqResult.append(
        `Zahtevek je oddan. ID: ${data.id} -- status: `,
        makeBadge('pending', 'v čakanju'),
        '. Status lahko preveriš spodaj z ID-jem.'
      );
      els.form.reset();
    } else {
      els.reqResult.className = 'form-result is-err';
      els.reqResult.textContent = data.error ?? `Pošiljanje ni uspelo (napaka ${res.status}).`;
    }
  } catch {
    els.reqResult.className = 'form-result is-err';
    els.reqResult.textContent = 'Strežnik ni dosegljiv -- zahtevka ni bilo mogoče oddati.';
  } finally {
    button.disabled = false;
  }
}

function makeBadge(status, label) {
  const badge = document.createElement('span');
  badge.className = `status-badge ${status}`;
  badge.textContent = label;
  return badge;
}

async function checkRequest() {
  const id = els.checkInput.value.trim();
  els.checkResult.className = 'form-result';
  if (!id) {
    els.checkResult.textContent = 'Vpiši ID zahtevka.';
    return;
  }
  els.checkResult.textContent = 'Preverjam …';
  try {
    const res = await fetch(`/api/requests/${encodeURIComponent(id)}`);
    const data = await res.json().catch(() => ({}));
    if (res.status === 404) {
      els.checkResult.className = 'form-result is-warn';
      els.checkResult.textContent = 'Zahtevek s tem ID ne obstaja.';
      return;
    }
    if (!res.ok) {
      els.checkResult.className = 'form-result is-err';
      els.checkResult.textContent = data.error ?? `Napaka ${res.status}.`;
      return;
    }
    els.checkResult.className = 'form-result';
    els.checkResult.innerHTML = '';
    const labels = {
      pending: ['pending', 'v čakanju'],
      approved: ['approved', 'odobreno'],
      rejected: ['rejected', 'zavrnjeno'],
    };
    const [cls, label] = labels[data.status] ?? ['pending', data.status];
    els.checkResult.append(makeBadge(cls, label));
    const detail = document.createElement('span');
    detail.textContent = ` ${data.artist ? `${data.artist} — ` : ''}${data.title}`;
    els.checkResult.appendChild(detail);
    if (data.note) {
      const note = document.createElement('p');
      note.textContent = `Opomba lastnika: ${data.note}`;
      els.checkResult.appendChild(note);
    }
  } catch {
    els.checkResult.className = 'form-result is-err';
    els.checkResult.textContent = 'Strežnik ni dosegljiv.';
  }
}

// ---------- player controls ----------

function setPlayIcon(playing) {
  els.playButton.querySelector('.icon-play').hidden = playing;
  els.playButton.querySelector('.icon-pause').hidden = !playing;
  els.playButton.setAttribute('aria-pressed', String(playing));
  els.playButton.setAttribute('aria-label', playing ? 'Ustavi' : 'Predvajaj');
}

els.playButton.addEventListener('click', () => {
  if (!streamStarted) {
    player.src = '/stream';
    streamStarted = true;
    setStatus('Povezujem s tokom …');
  }
  if (player.paused) player.play().catch(() => setStatus('Predvajanja ni bilo mogoče začeti -- poskusi znova.', 'is-error'));
  else player.pause();
});

// Lock-screen / headphone-widget actions mirror the on-page button exactly.
// Only play/pause/stop are set -- next/previous/seek stay unwired on
// purpose (one shared stream, radio semantics; see the MediaSession comment
// near the top of this file).
if ('mediaSession' in navigator) {
  try {
    navigator.mediaSession.setActionHandler('play', () => {
      if (!streamStarted) { player.src = '/stream'; streamStarted = true; }
      player.play().catch(() => {});
    });
    navigator.mediaSession.setActionHandler('pause', () => player.pause());
    navigator.mediaSession.setActionHandler('stop', () => player.pause());
  } catch { /* older browsers -- the on-page button keeps working */ }
}

player.addEventListener('playing', () => {
  setPlayIcon(true);
  setStatus('V predvajanju.', 'is-ok');
  if ('mediaSession' in navigator) {
    try { navigator.mediaSession.playbackState = 'playing'; } catch { /* ignore */ }
  }
});
player.addEventListener('pause', () => {
  setPlayIcon(false);
  if (streamStarted) setStatus('Zaustavljeno. Tok ostaja na zadnji točki -- s predvajanjem se pridružiš v živo.');
  if ('mediaSession' in navigator) {
    try { navigator.mediaSession.playbackState = 'paused'; } catch { /* ignore */ }
  }
});
player.addEventListener('waiting', () => setStatus('Čakam na podatke toka …'));
player.addEventListener('stalled', () => setStatus('Tok se je ustavil -- poskušam znova …', 'is-warn'));
player.addEventListener('error', () => {
  if (streamStarted) setStatus('Tok ni dosegljiv (strežnik ali povezava). Preveri, ali postaja teče, in poskusi znova.', 'is-error');
});

// Volume + mute, persisted locally.
const VOL_KEY = 'radioclyde-volume';
function applyVolume() {
  const v = Number(els.volume.value) / 100;
  player.volume = v;
  player.muted = v === 0;
  const muted = player.muted;
  els.muteButton.querySelector('.icon-vol').hidden = muted;
  els.muteButton.querySelector('.icon-muted').hidden = !muted;
  els.muteButton.setAttribute('aria-pressed', String(muted));
  els.muteButton.setAttribute('aria-label', muted ? 'Vklopi zvok' : 'Utišaj');
  try {
    localStorage.setItem(VOL_KEY, els.volume.value);
  } catch { /* ignore */ }
}
els.volume.addEventListener('input', applyVolume);
els.muteButton.addEventListener('click', () => {
  els.volume.value = player.muted || player.volume === 0 ? 80 : 0;
  applyVolume();
});
try {
  const saved = localStorage.getItem(VOL_KEY);
  if (saved !== null) els.volume.value = saved;
} catch { /* ignore */ }
applyVolume();

els.likeButton.addEventListener('click', () => {
  if (!currentTrackKey) return;
  toggleFav(...currentTrackKey);
});

// ---------- tabs ----------

const TABS = [
  { tab: 'tab-now', panel: 'panel-now', onShow: null },
  { tab: 'tab-schedule', panel: 'panel-schedule', onShow: fetchSchedule },
  { tab: 'tab-requests', panel: 'panel-requests', onShow: null },
  { tab: 'tab-podcast', panel: 'panel-podcast', onShow: fetchPodcast },
];

function selectTab(id) {
  for (const { tab, panel, onShow } of TABS) {
    const active = tab === id;
    $(tab).setAttribute('aria-selected', String(active));
    $(panel).hidden = !active;
    if (active && onShow) onShow();
  }
}
for (const { tab } of TABS) $(tab).addEventListener('click', () => selectTab(tab));

// Retry buttons
document.querySelectorAll('[data-retry]').forEach((btn) =>
  btn.addEventListener('click', () => {
    const what = btn.dataset.retry;
    if (what === 'history') fetchHistory();
    if (what === 'toplistened') fetchTopListened();
    if (what === 'upcoming') fetchUpcoming();
    if (what === 'schedule') fetchSchedule();
    if (what === 'podcast') fetchPodcast();
  })
);

// ---------- podkast ----------

const POD_DATE_FMT = new Intl.DateTimeFormat('sl-SI', { day: 'numeric', month: 'long', year: 'numeric' });

function podDuration(seconds) {
  if (!Number.isFinite(seconds) || seconds <= 0) return '';
  const total = Math.round(seconds);
  const m = Math.floor(total / 60);
  return `${m}:${String(total % 60).padStart(2, '0')}`;
}

function renderPodcast(data) {
  els.podRss.value = data.feedUrl ?? '';
  els.podList.innerHTML = '';
  const episodes = Array.isArray(data.episodes) ? data.episodes : [];
  if (episodes.length === 0) {
    const p = document.createElement('p');
    p.className = 'hint';
    p.textContent = 'Podkast \u0161e ni objavljen -- epizoda nastane z gumbom v studiu ali z ukazom podcast-audio. Kadarkoli bo, se pojavi tukaj.';
    els.podList.appendChild(p);
    return;
  }
  for (const ep of episodes) {
    const item = document.createElement('article');
    item.className = 'pod-item';
    const meta = [POD_DATE_FMT.format(new Date(`${ep.date}T12:00:00`))];
    const dur = podDuration(ep.seconds);
    if (dur) meta.push(dur);

    const head = document.createElement('div');
    head.className = 'pod-item-head';
    const h3 = document.createElement('h3');
    h3.textContent = ep.title;
    const span = document.createElement('span');
    span.className = 'pod-meta';
    span.textContent = meta.join(' -- ');
    head.append(h3, span);
    item.appendChild(head);

    if (ep.hasAudio && ep.audioUrl) {
      const audio = document.createElement('audio');
      audio.controls = true;
      audio.preload = 'none';
      audio.src = ep.audioUrl;
      item.appendChild(audio);
      // Poglavja (izmerjeni zamiki iz plana) -- samo kadar obstajajo; prazno
      // stanje se ne izumlja.
      if (Array.isArray(ep.chapters) && ep.chapters.length > 0) {
        const det = document.createElement('details');
        const sum = document.createElement('summary');
        sum.textContent = `Poglavja (${ep.chapters.length})`;
        det.appendChild(sum);
        const ul = document.createElement('ul');
        ul.className = 'pod-chapters';
        for (const ch of ep.chapters) {
          const li = document.createElement('li');
          const mm = Math.floor((ch.startMs ?? 0) / 60000);
          const ss = String(Math.floor(((ch.startMs ?? 0) % 60000) / 1000)).padStart(2, '0');
          li.textContent = `${mm}:${ss} ${ch.title}`;
          ul.appendChild(li);
        }
        det.appendChild(ul);
        item.appendChild(det);
      }
    } else {
      const note = document.createElement('p');
      note.className = 'hint';
      note.textContent = 'Epizoda \u0161e brez zvoka -- skripta obstaja, zvok pa se \u0161e ni izdelal.';
      item.appendChild(note);
    }
    els.podList.appendChild(item);
  }
}

async function fetchPodcast() {
  els.podError.hidden = true;
  try {
    const res = await fetch('/api/podcast');
    if (!res.ok) throw new Error(res.status);
    renderPodcast(await res.json());
  } catch {
    els.podList.innerHTML = '';
    els.podError.hidden = false;
  }
}

els.podRssCopy.addEventListener('click', async () => {
  const value = els.podRss.value;
  if (!value) return;
  try {
    await navigator.clipboard.writeText(value);
    els.podRssCopy.textContent = 'Kopirano';
  } catch {
    // clipboard API zahteva varni kontekst -- zanesljiv nadomestek: ro&ccaron;na izbira
    els.podRss.focus();
    els.podRss.select();
    document.execCommand('copy');
    els.podRssCopy.textContent = 'Kopirano';
  }
  setTimeout(() => { els.podRssCopy.textContent = 'Kopiraj RSS'; }, 2000);
});

// ---------- najbolj poslusano ----------

function topDeltaChip(delta) {
  const d = Number(delta) || 0;
  const rounded = Math.round(Math.abs(d) * 10) / 10;
  const sign = d > 0 ? '\u25B2' : d < 0 ? '\u25BC' : '\u25CF';
  const num = rounded.toLocaleString('sl-SI', { maximumFractionDigits: 1 });
  return `${sign}${d > 0 ? '+' : d < 0 ? '\u2212' : '\u00B1'}${num}`;
}

function renderTopListened(data) {
  els.topWindow.textContent = data.windowDays ? `-- ${data.windowDays} dni` : '';
  els.topList.replaceChildren();
  const tracks = Array.isArray(data.tracks) ? data.tracks : [];
  if (tracks.length === 0) {
    els.topEmpty.textContent = data.note ?? 'Seznam je prazen.';
    els.topEmpty.hidden = false;
    return;
  }
  els.topEmpty.hidden = true;
  tracks.forEach((t, i) => {
    const li = document.createElement('li');
    li.className = 'top-row';
    const rank = document.createElement('span');
    rank.className = 'top-rank';
    rank.textContent = `${i + 1}.`;
    const name = document.createElement('span');
    name.className = 'top-name';
    name.textContent = `${t.artist} -- ${t.title}`;
    const meta = document.createElement('span');
    meta.className = 'top-meta';
    const plays = document.createElement('span');
    plays.textContent = `${t.plays}\u00D7`;
    plays.title = `${t.plays} predvajanj v oknu`;
    const chip = document.createElement('span');
    chip.className = `top-chip ${t.avgDelta > 0 ? 'top-up' : t.avgDelta < 0 ? 'top-down' : 'top-flat'}`;
    chip.textContent = topDeltaChip(t.avgDelta);
    chip.title = `V povpre\u010Dju ${t.listenersAvg} poslu\u0161alcev med skladbo`;
    meta.append(plays, chip);
    li.append(rank, name, meta);
    els.topList.appendChild(li);
  });
}

async function fetchTopListened() {
  els.topError.hidden = true;
  try {
    const res = await fetch('/api/top-listened');
    if (!res.ok) throw new Error(res.status);
    renderTopListened(await res.json());
  } catch {
    els.topList.replaceChildren();
    els.topEmpty.hidden = true;
    els.topError.hidden = false;
  }
}

// ---------- P5 #4: push opt-in (obvestilo ob začetku oddaje) ----------
//
// Resnica o stanju je pushManager.getSubscription() brskalnika -- ne
// localStorage (tisti bi lahal po odstranitvi naročnine drugje). Vklop:
// dovoljenje -> subscribe z javnim VAPID ključem s strežnika -> POST
// /api/push/subscribe. Izklop: unsubscribe + POST /api/push/unsubscribe.
// Neuspeh je vedno viden v status vrstici, nikoli tiho.

const PUSH_LEAD_HINT = 'Obvestilo pride tik pred začetkom oddaje.';

function pushCapabilitiesNote() {
  if (!('serviceWorker' in navigator) || !('PushManager' in window) || !('Notification' in window)) {
    return 'Ta brskalnik ne podpira push obvestil.';
  }
  if (!window.isSecureContext) {
    return 'Push deluje samo prek HTTPS (ali na localhost).';
  }
  return null;
}

async function setPushStatus(text, showButton) {
  els.pushStatus.textContent = text;
  els.pushStatus.hidden = !text;
  els.pushButton.hidden = showButton !== true;
}

async function renderPushState() {
  const note = pushCapabilitiesNote();
  if (note) {
    await setPushStatus(note, false);
    return;
  }
  try {
    const registration = await navigator.serviceWorker.getRegistration();
    const subscription = registration ? await registration.pushManager.getSubscription() : null;
    if (subscription) {
      els.pushButton.textContent = 'Izklopi obvestila';
      await setPushStatus(`Obvestila so vklopljena. ${PUSH_LEAD_HINT}`, true);
    } else {
      els.pushButton.textContent = 'Vklopi obvestila';
      await setPushStatus('', true);
    }
  } catch {
    await setPushStatus('Stanja obvestil ni bilo mogoče preveriti.', false);
  }
}

async function enablePush() {
  const permission = await Notification.requestPermission();
  if (permission !== 'granted') {
    await setPushStatus('Dovoljenje za obvestila ni bilo dano -- vklopi ga v nastavitvah brskalnika.', false);
    return;
  }
  const registration = await navigator.serviceWorker.ready;
  let vapidKey;
  try {
    const res = await fetch('/api/push/vapid');
    if (!res.ok) throw new Error(res.status);
    vapidKey = (await res.json()).publicKey;
  } catch {
    await setPushStatus('Strežnik trenutno ne omogoča prijave na obvestila (rute /api/push so zaprte ali nedosegljive).', false);
    return;
  }
  const subscription = await registration.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: vapidKey,
  });
  const record = subscription.toJSON();
  const res = await fetch('/api/push/subscribe', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ endpoint: record.endpoint, keys: record.keys }),
  });
  if (!res.ok) {
    // Ne pusti pol-odprte naročbine: odjavimo jo, da UI ne laže.
    await subscription.unsubscribe().catch(() => {});
    await setPushStatus(`Strežnik je zavrnil prijavo (napaka ${res.status}). Poskusi znova kasneje.`, false);
    return;
  }
  els.pushButton.textContent = 'Izklopi obvestila';
  await setPushStatus(`Obvestila so vklopljena. ${PUSH_LEAD_HINT}`, true);
}

async function disablePush() {
  const registration = await navigator.serviceWorker.getRegistration();
  const subscription = registration ? await registration.pushManager.getSubscription() : null;
  if (subscription) {
    const endpoint = subscription.endpoint;
    await subscription.unsubscribe().catch(() => {});
    await fetch('/api/push/unsubscribe', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ endpoint }),
    }).catch(() => {});
  }
  els.pushButton.textContent = 'Vklopi obvestila';
  await setPushStatus('Obvestila so izklopljena.', true);
}

async function onPushButtonClick() {
  els.pushButton.disabled = true;
  try {
    const registration = await navigator.serviceWorker.getRegistration();
    const subscription = registration ? await registration.pushManager.getSubscription() : null;
    if (subscription) await disablePush();
    else await enablePush();
  } catch {
    await setPushStatus('Upravljanje obvestil ni uspelo -- poskusi znova.', true);
  } finally {
    els.pushButton.disabled = false;
  }
}

// ---------- boot ----------

els.form.addEventListener('submit', submitRequest);
els.checkButton.addEventListener('click', checkRequest);
els.pushButton.addEventListener('click', onPushButtonClick);

renderFavs();
renderPushState();
fetchNowPlaying();
fetchHistory();
fetchTopListened();
fetchUpcoming();
fetchWeather();
fetchListeners();
setInterval(fetchNowPlaying, POLL_MS);
setInterval(fetchHistory, POLL_MS);
setInterval(fetchUpcoming, POLL_MS);
setInterval(fetchWeather, 10 * 60 * 1000);
setInterval(fetchListeners, 60 * 1000);
setInterval(fetchSchedule, SCHEDULE_POLL_MS); // keeps marks fresh while the tab is open
setInterval(tickProgress, 1000);

// PWA: register the service worker (shell caching only -- /stream and /api
// pass through uncached, see sw.js). Failure is silent by design: the page
// is fully functional as a classic web app without it.
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch(() => {});
  });
}
