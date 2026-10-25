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
  shareButton: $('share-button'),
  sleepButton: $('sleep-button'),
  sleepLabel: $('sleep-label'),
  sleepPopover: $('sleep-popover'),
  sleepOff: $('sleep-off'),
  themeButton: $('theme-button'),
  themePopover: $('theme-popover'),
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
  pollCard: $('poll-card'),
  pollQuestion: $('poll-question'),
  pollOptions: $('poll-options'),
  pollTotal: $('poll-total'),
  pollStatus: $('poll-status'),
  lyricsToggle: $('lyrics-toggle'),
  lyricsPanel: $('lyrics-panel'),
  lyricsStatus: $('lyrics-status'),
  lyricsLines: $('lyrics-lines'),
  lyricsOffset: $('lyrics-offset'),
  lyricsOffsetValue: $('lyrics-offset-value'),
  lyricsOffsetDown: $('lyrics-offset-down'),
  lyricsOffsetUp: $('lyrics-offset-up'),
  lyricsOffsetReset: $('lyrics-offset-reset'),
};

const SL_DAYS = { monday: 'Ponedeljek', tuesday: 'Torek', wednesday: 'Sreda', thursday: 'Četrtek', friday: 'Petek', saturday: 'Sobota', sunday: 'Nedelja' };

let streamStarted = false;
let trackIsPlaying = false;
let currentTrackTiming = null; // { playedAt epoch ms, durationMs } -- ticked client-side between polls
let currentTrackKey = null; // [artist, title] of the airing track -- spread into isFav()/toggleFav(); the localStorage key itself is built by trackKey()
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

// ---------- response-ordering guards ----------
//
// Interval pollers can interleave with themselves: a stalled older response
// resolving after a newer one would repaint the page with older data. The
// worst case was fetchNowPlaying -- the rewind also flowed into
// lyricsOnNowPlaying(), wiping and refetching the lyrics panel for the
// previous song. Each guarded fetcher issues a monotonic token before its
// await and only touches the DOM while it is still the newest ask; a
// superseded response (success OR failure) returns silently -- the newer
// ask owns the UI. The lyrics module keeps its own epoch guard (already
// correct) and is deliberately not touched here.
function fetchSeq() {
  let latest = 0;
  return {
    next: () => ++latest,
    isNewest: (token) => token === latest,
  };
}

const nowPlayingSeq = fetchSeq(); // hero + lyrics cascade
const historySeq = fetchSeq();
const upcomingSeq = fetchSeq();
const scheduleSeq = fetchSeq(); // tab onShow, retry button and the 5-min tick
const topListenedSeq = fetchSeq(); // boot + retry button

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
  // currentTrackKey is the [artist, title] array assigned in renderNowPlaying
  // (line ~266) -- spread it straight through. The old .split(' — ') form
  // assumed a string and threw on every playing track; the TypeError was
  // swallowed by fetchNowPlaying's catch, silently skipping the like-button
  // state and every later step of that poll tick.
  const liked = currentTrackKey ? isFav(...currentTrackKey) : false;
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
        // 'any': the logo is 854x466 and /api/art covers vary per track -- a
        // hardcoded 512x512 lied about both, and MediaSession picks by size.
        { src: new URL(artUrl || '/logo.png', location.href).href, sizes: 'any', type: artUrl ? 'image/jpeg' : 'image/png' },
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
  updateStationStreams(data.station);
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
    // The img shows a DJ photo here, not a track cover -- the alt must say so
    // (persona is an internal id, so the alt stays generic and honest).
    els.art.alt = 'Fotografija DJ-ja na etru';
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
      els.art.alt = 'Naslovnica trenutne skladbe';
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
  lyricsOnNowPlaying(data); // besedila: keeps its own clock, restarts polling at track boundaries
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
  const mine = nowPlayingSeq.next();
  try {
    const res = await fetch('/api/now-playing');
    if (!res.ok) throw new Error(res.status);
    const data = await res.json();
    if (!nowPlayingSeq.isNewest(mine)) return; // superseded -- see fetchSeq()
    renderNowPlaying(data);
  } catch {
    if (!nowPlayingSeq.isNewest(mine)) return;
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
  const mine = historySeq.next();
  try {
    const res = await fetch('/api/history?limit=20');
    if (!res.ok) throw new Error(res.status);
    const { entries } = await res.json();
    if (!historySeq.isNewest(mine)) return;
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
    if (historySeq.isNewest(mine)) show(els.historyError, true);
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
  const mine = upcomingSeq.next();
  try {
    const res = await fetch('/api/upcoming');
    if (!res.ok) throw new Error(res.status);
    const { shows } = await res.json();
    if (!upcomingSeq.isNewest(mine)) return;
    els.upcomingList.replaceChildren(...(shows ?? []).map(upcomingRow));
    show(els.upcomingEmpty, (shows ?? []).length === 0);
    show(els.upcomingError, false);
  } catch {
    if (upcomingSeq.isNewest(mine)) show(els.upcomingError, true);
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
  const mine = scheduleSeq.next();
  try {
    const res = await fetch('/api/schedule');
    if (!res.ok) throw new Error(res.status);
    const data = await res.json();
    if (!scheduleSeq.isNewest(mine)) return;
    renderSchedule(data);
  } catch {
    if (scheduleSeq.isNewest(mine)) show(els.scheduleError, true);
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

// ---------- stream format picker (SUB/WAVE rule) ----------
//
// MP3 is the floor. The player upgrades to the station's Opus mount only
// when ALL of these hold: /api/now-playing actually lists an opus stream
// (icecast.opus.enabled on the server), canPlayType('audio/ogg;
// codecs=opus') answers 'probably', and the browser is neither iOS nor
// Firefox (both break on chained Ogg at a crossfade -- SUB/WAVE's measured
// call, #212). The upgrade lands on the next tune (the src assignment in
// startStream below), never on a playing element (#1232/#1234); an Opus
// error pins MP3 for the rest of the session. FLAC is deliberately NOT
// offered to the web player (docs/stream-mounts.md): it is for audiophile
// players via the published playlists, not a browser codec bet.

let stationStreams = null;        // [{url, format, bitrate}] from station.streams
let opusPinnedToMp3 = false;      // session-permanent downgrade after an Opus error
let currentStreamIsOpus = false;  // what player.src currently points at

function updateStationStreams(station) {
  stationStreams = Array.isArray(station && station.streams) ? station.streams : null;
}

function canPlayOpus() {
  try {
    if (opusPinnedToMp3) return false;
    const nav = typeof navigator !== 'undefined' ? navigator : null;
    if (nav) {
      const ua = String(nav.userAgent || '');
      // iP(hone|ad|od) covers iPhone/iPad/iPod; iPadOS 13+ masquerades as
      // Mac Safari -- touch points give it away. Firefox-for-iOS reports
      // FxiOS and is already caught by the iPad branch (SUB/WAVE's note).
      if (/iP(hone|ad|od)/.test(ua)) return false;
      if (/firefox/i.test(ua)) return false;
      if (nav.platform === 'MacIntel' && (nav.maxTouchPoints || 0) > 1) return false;
    }
    return document.createElement('audio').canPlayType('audio/ogg; codecs=opus') === 'probably';
  } catch { return false; }
}

function opusStreamUrl() {
  if (!stationStreams) return null;
  const opus = stationStreams.find((s) => s && s.format === 'opus' && s.url);
  return opus ? opus.url : null;
}

function pickStreamSrc() {
  const opus = canPlayOpus() ? opusStreamUrl() : null;
  return opus || '/stream';
}

// The ONE place player.src is assigned for the live stream (the play
// button and the MediaSession handlers both route through here), so the
// format choice is always a fresh, session-consistent decision.
function startStream() {
  const src = pickStreamSrc();
  currentStreamIsOpus = src !== '/stream';
  player.src = src;
  streamStarted = true;
  setStatus('Povezujem s tokom …');
}

// ---------- player controls ----------

function setPlayIcon(playing) {
  els.playButton.querySelector('.icon-play').hidden = playing;
  els.playButton.querySelector('.icon-pause').hidden = !playing;
  els.playButton.setAttribute('aria-pressed', String(playing));
  els.playButton.setAttribute('aria-label', playing ? 'Ustavi' : 'Predvajaj');
  // The tooltip mirrors the dynamic aria-label -- with the shortcut hint
  // riding along (there was no title in the static markup to clobber).
  els.playButton.title = playing ? 'Ustavi (preslednica)' : 'Predvajaj (preslednica)';
}

els.playButton.addEventListener('click', () => {
  if (!streamStarted) startStream();
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
      if (!streamStarted) startStream();
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
  // An Opus mount error pins MP3 for the session (SUB/WAVE's rule: a
  // failing mount must not re-arm on the next press) and retries once on
  // the MP3 floor before reporting failure honestly.
  if (currentStreamIsOpus) {
    opusPinnedToMp3 = true;
    currentStreamIsOpus = false;
    if (streamStarted) {
      setStatus('Opus tok ni dosegljiv -- preusmerjam na MP3 …', 'is-warn');
      player.src = '/stream';
      player.play().catch(() => {});
      return;
    }
  }
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
  // Same honest-state treatment as the play button's tooltip.
  els.muteButton.title = muted ? 'Vklopi zvok (M)' : 'Utišaj (M)';
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

// A 404 on the hero art (missing DJ photo or a track Plex has no cover for)
// shows the fallback tile instead of a torn frame -- mirrors the history-row
// handler's hide-on-error idea, attached once for this single hero element.
els.art.addEventListener('error', () => {
  els.art.hidden = true;
  els.artFallback.hidden = false;
});

// ---------- spanje (sleep timer) ----------
//
// "Spanje" stops playback after a chosen number of minutes (15/30/60/90),
// NTS/KEXP-style. Honesty rules the whole module:
//  - The countdown is anchored to Date.now(), never to tick counts: hidden
//    tabs throttle intervals to a crawl, so every wake-up recomputes the
//    remaining time from the anchor, and a visibilitychange catch-up fires
//    the wind-down the moment a suspended tab returns past T-0.
//  - At T-0 the volume ramps down over ~5 s, then the stream pauses through
//    the existing pause path (player.pause() -> the 'pause' listener keeps
//    the play button honest), then the slider value is re-applied so the
//    next play starts at the listener's chosen volume again.
//  - Some iOS WebKit builds ignore element.volume writes (read-only in
//    practice): there the ramp is silently a no-op, but the pause at its
//    end is unconditional, so the timer still ends in a clean stop.
//  - Manual play/pause during a countdown never cancels it -- that is the
//    point of a sleep timer; the label keeps counting so the user knows.

const SLEEP_FADE_MS = 5000;
const SLEEP_FADE_STEP_MS = 100;
const SLEEP_TICK_MS = 1000;

const sleepState = {
  endAt: null,    // epoch-ms anchor of T-0; null = no timer armed
  minutes: null,  // picked duration -- highlights the popover option
  fading: false,  // T-0 reached, volume ramp in flight
  tickTimer: null,
  fadeTimer: null,
  labelText: '',  // last label written -- a steady tick must not churn the DOM
};

function sleepRemainingMs() {
  if (sleepState.endAt == null) return null;
  return sleepState.endAt - Date.now();
}

function sleepLabelText() {
  if (sleepState.fading) return 'spanje: 0 min';
  const remaining = sleepRemainingMs();
  if (remaining == null) return 'Spanje';
  return `spanje: ${Math.max(0, Math.ceil(remaining / 60000))} min`;
}

// One renderer for the trigger + the popover options. The countdown lives
// in the control's own label (visible, quiet -- no per-minute live-region
// spam); state TRANSITIONS are announced through the existing player-status
// role="status" line instead (setSleepTimer / fireSleepEnd / cancel).
function updateSleepControl() {
  const active = sleepState.endAt != null || sleepState.fading;
  els.sleepButton.setAttribute('aria-pressed', String(active));
  const label = sleepLabelText();
  if (label !== sleepState.labelText) {
    sleepState.labelText = label;
    els.sleepLabel.textContent = label;
  }
  els.sleepPopover.querySelectorAll('[data-sleep-min]').forEach((b) => {
    b.setAttribute('aria-pressed', String(active && Number(b.dataset.sleepMin) === sleepState.minutes));
  });
  els.sleepOff.disabled = !active; // nothing to switch off without an armed timer
}

function setSleepPopover(open) {
  els.sleepPopover.hidden = !open;
  els.sleepButton.setAttribute('aria-expanded', String(open));
}

function stopSleepTimers() {
  if (sleepState.tickTimer != null) {
    clearInterval(sleepState.tickTimer);
    sleepState.tickTimer = null;
  }
  if (sleepState.fadeTimer != null) {
    clearInterval(sleepState.fadeTimer);
    sleepState.fadeTimer = null;
  }
}

function tickSleep() {
  if (sleepState.endAt == null) return; // fired or cancelled -- the interval is gone
  if (sleepRemainingMs() <= 0) {
    fireSleepEnd();
    return;
  }
  updateSleepControl();
}

function setSleepTimer(minutes) {
  // A fresh duration replaces whatever is running -- including a wind-down
  // already in flight: its partial ramp is undone from the slider's truth.
  const wasFading = sleepState.fading;
  stopSleepTimers();
  sleepState.fading = false;
  if (wasFading) applyVolume();
  sleepState.endAt = Date.now() + minutes * 60 * 1000;
  sleepState.minutes = minutes;
  sleepState.tickTimer = setInterval(tickSleep, SLEEP_TICK_MS);
  updateSleepControl();
  setStatus(`Spanje: predvajanje se bo ustavilo čez ${minutes} min.`);
}

function cancelSleepTimer() {
  const wasFading = sleepState.fading;
  if (sleepState.endAt == null && !wasFading) return; // nothing armed -- quiet no-op
  stopSleepTimers();
  sleepState.endAt = null;
  sleepState.minutes = null;
  sleepState.fading = false;
  if (wasFading) applyVolume(); // undo the partial ramp, back to the slider's truth
  updateSleepControl();
  setStatus('Spanje je izklopljeno.');
}

function fireSleepEnd() {
  if (sleepState.endAt == null || sleepState.fading) return; // not armed / already winding down
  sleepState.endAt = null; // idempotent across the tick, visibilitychange and any late wake-up
  stopSleepTimers();
  if (player.paused) {
    // The listener had already paused manually (the timer survives manual
    // control by design): nothing to fade or stop -- just close the chapter.
    sleepState.minutes = null;
    updateSleepControl();
    setStatus('Spanje je poteklo.');
    return;
  }
  beginSleepFade();
}

function beginSleepFade() {
  sleepState.fading = true;
  updateSleepControl();
  setStatus('Spanje: nežno ugašam …');
  const startedAt = Date.now();
  const fromVolume = player.volume;
  sleepState.fadeTimer = setInterval(() => {
    const t = Math.min(1, (Date.now() - startedAt) / SLEEP_FADE_MS);
    // iOS honesty: on builds where element.volume is effectively read-only
    // this write changes nothing audible -- the pause below still ends the
    // timer cleanly, just without the gentle fade.
    player.volume = fromVolume * (1 - t);
    if (t >= 1) endSleepFade();
  }, SLEEP_FADE_STEP_MS);
}

function endSleepFade() {
  if (!sleepState.fading) return;
  sleepState.fading = false;
  stopSleepTimers();
  sleepState.minutes = null;
  const shouldPause = !player.paused;
  if (shouldPause) player.pause(); // the existing pause path -> 'pause' event keeps the button honest
  // Restore for the next play from the slider -- the one source of truth.
  // If the listener moved the slider during the ramp, THEIR value wins here
  // (the "user changed it meanwhile" rule); otherwise this re-applies the
  // pre-fade value. The mute-icon state re-syncs in the same sweep.
  applyVolume();
  updateSleepControl();
  if (shouldPause) {
    // pause() queues the 'pause' event, whose handler rewrites this very
    // status line ('Zaustavljeno …') right after us -- say the honest sleep
    // line once that has landed.
    setTimeout(() => setStatus('Spanje je poteklo -- predvajanje ustavljeno.'), 0);
  } else {
    setStatus('Spanje je poteklo.');
  }
}

// A suspended tab can sleep straight through T-0 (timers do not run there
// at all): the moment it becomes visible again the wind-down fires at once,
// instead of waiting for the next (throttled) tick to notice.
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible') return;
  if (sleepState.endAt == null) return;
  if (sleepRemainingMs() <= 0) fireSleepEnd();
  else updateSleepControl(); // refresh the label without waiting a throttled tick
});

els.sleepButton.addEventListener('click', () => setSleepPopover(els.sleepPopover.hidden));
els.sleepPopover.querySelectorAll('[data-sleep-min]').forEach((b) => {
  b.addEventListener('click', () => {
    setSleepTimer(Number(b.dataset.sleepMin));
    setSleepPopover(false);
    els.sleepButton.focus(); // the chosen option vanishes -- hand focus back to the trigger
  });
});
els.sleepOff.addEventListener('click', () => {
  cancelSleepTimer();
  setSleepPopover(false);
  els.sleepButton.focus();
});
// Clicking anywhere outside the wrap dismisses the popover. The trigger is
// inside the wrap, so its own click only ever toggles; option clicks close
// via their own handlers above.
document.addEventListener('click', (e) => {
  if (els.sleepPopover.hidden) return;
  const t = e.target;
  if (t && typeof t.closest === 'function' && t.closest('#sleep-wrap')) return;
  setSleepPopover(false);
});

// ---------- deli (share current track) ----------
//
// Web Share API when the platform has one (mobile intent sheets); an honest
// clipboard copy otherwise. The payload is built from the CURRENTLY RENDERED
// hero state: currentTrackKey -- the like-button's own source of truth --
// while a track airs, the station itself while the DJ talks or nothing airs
// (mirroring how renderNowPlaying branches: the key is null in exactly
// those branches, so no second source of truth is needed).

function shareStrings() {
  if (currentTrackKey) {
    const [artist, title] = currentTrackKey;
    const plain = artist ? `${artist} — ${title}` : title;
    return {
      shareText: `🎵 ${plain}`,
      clipboardText: `${plain} · poslušaj na ${location.href}`,
    };
  }
  return {
    shareText: 'Poslušaj Radio Markec v živo',
    clipboardText: `Poslušaj Radio Markec v živo · poslušaj na ${location.href}`,
  };
}

// Transient player-status line: shows the message, then restores whatever
// the line said before -- but only while OUR message is still on screen; a
// newer player event (stall, error, pause) always wins and is never stomped
// by a stale restore. (The lyrics panel announces through its own
// role="status"; this uses the player's existing one.)
let shareStatusTimer = null;
function shareTransientStatus(text, cls) {
  const prevText = els.status.textContent;
  const prevClass = els.status.className;
  setStatus(text, cls);
  if (shareStatusTimer != null) clearTimeout(shareStatusTimer);
  shareStatusTimer = setTimeout(() => {
    shareStatusTimer = null;
    if (els.status.textContent === text) {
      els.status.textContent = prevText;
      els.status.className = prevClass;
    }
  }, 4000);
}

async function shareCurrentTrack() {
  const { shareText, clipboardText } = shareStrings();
  if (typeof navigator.share === 'function') {
    try {
      await navigator.share({ title: 'Radio Markec', text: shareText, url: location.href });
    } catch {
      // The user dismissing the share sheet rejects with AbortError -- that
      // is a cancel, not an error worth reporting; anything else share()
      // throws is equally not the listener's problem.
    }
    return;
  }
  if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
    try {
      await navigator.clipboard.writeText(clipboardText);
      shareTransientStatus('Povezava skopirana.', 'is-ok');
    } catch {
      shareTransientStatus('Kopiranja ni bilo mogoče.', 'is-error');
    }
    return;
  }
  setStatus('Deljenje ni podprto v tem brskalniku.');
}

els.shareButton.addEventListener('click', shareCurrentTrack);

// ---------- teme (theme picker) ----------
//
// Four skins, one localStorage key ('radioclyde-theme'), chosen per listener
// per device. The pre-paint inline script in index.html's <head> already
// stamped the saved id onto <html data-theme> before the first paint; this
// module owns everything AFTER that: applying a choice (attribute + meta
// theme-color + picker radios), persisting it, and the picker popover
// itself. A station-wide default theme is deliberately NOT offered this
// wave: the listener page is served as a static file with no templating, so
// the honest choice is the listener's own (Klasika default = today's look).

const THEME_KEY = 'radioclyde-theme';

// PAIRING NOTE: each bg below must equal that theme's --bg in style.css --
// the meta theme-color tag wants a concrete color, not a var(). Keep the
// four entries in step with the [data-theme] blocks (and with the id list
// inside the pre-paint script in index.html).
const THEMES = {
  klasika: { label: 'Klasika', bg: '#0a0c12' },
  jutro: { label: 'Jutro', bg: '#f7f3ec' },
  vinil: { label: 'Vinil', bg: '#17120e' },
  terminal: { label: 'Terminal', bg: '#060a07' },
};

// One renderer for the theme's whole visible state: <html data-theme>
// (always an explicit id, 'klasika' included, so the CSS selectors stay
// uniform), the meta theme-color (browser chrome), the picker's radio
// aria-checked matrix, and the trigger's aria-pressed ("a custom look is
// active" -- false exactly on Klasika). No status line here: boot must be
// quiet, the ANNOUNCED transition lives in applyTheme().
function syncThemeUI(theme) {
  document.documentElement.dataset.theme = theme;
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute('content', THEMES[theme].bg);
  els.themePopover.querySelectorAll('[data-theme-id]').forEach((b) => {
    b.setAttribute('aria-checked', String(b.dataset.themeId === theme));
  });
  els.themeButton.setAttribute('aria-pressed', String(theme !== 'klasika'));
}

function applyTheme(id) {
  // Unknown ids (stale storage, tampering) degrade honestly to Klasika.
  const theme = THEMES[id] ? id : 'klasika';
  syncThemeUI(theme);
  try {
    localStorage.setItem(THEME_KEY, theme);
  } catch { /* private mode -- this device falls back to Klasika on reload */ }
  // The share feature's transient-status helper is page-global by design
  // (it owns the player-status restore guard) -- reuse it, do not fork it.
  shareTransientStatus(`Tema: ${THEMES[theme].label}.`, 'is-ok');
}

// Boot: the pre-paint script already applied the theme to <html>; catch
// the picker's own state up to it (and re-assert the meta tag, so a stale
// build can never ship a wrong chrome color). Quiet -- no boot announcement.
syncThemeUI(THEMES[document.documentElement.dataset.theme] ? document.documentElement.dataset.theme : 'klasika');

// The picker mirrors the sleep popover (trigger + hidden popover + chip-btn
// options + Esc/outside-click close + refocus trigger). ONE deliberate
// difference: opening it moves focus onto the checked radio, because a
// radiogroup's arrow-key navigation only works from inside the group -- the
// sleep options are plain buttons and keep the trigger's focus instead.
function setThemePopover(open) {
  els.themePopover.hidden = !open;
  els.themeButton.setAttribute('aria-expanded', String(open));
  if (open) {
    const options = Array.from(els.themePopover.querySelectorAll('[data-theme-id]'));
    const checked = options.find((b) => b.getAttribute('aria-checked') === 'true') || options[0];
    if (checked) checked.focus();
  }
}

// Arrow keys cycle the radios (wrapping), ARIA radiogroup style.
function moveThemeFocus(key) {
  const options = Array.from(els.themePopover.querySelectorAll('[data-theme-id]'));
  if (options.length === 0) return;
  const idx = Math.max(0, options.indexOf(document.activeElement));
  const delta = key === 'ArrowUp' || key === 'ArrowLeft' ? -1 : 1;
  options[(idx + delta + options.length) % options.length].focus();
}

els.themeButton.addEventListener('click', () => setThemePopover(els.themePopover.hidden));
els.themePopover.querySelectorAll('[data-theme-id]').forEach((b) => {
  b.addEventListener('click', () => {
    applyTheme(b.dataset.themeId);
    setThemePopover(false);
    els.themeButton.focus(); // same dismissal contract as the sleep picker
  });
});
// Clicking anywhere outside the wrap dismisses the popover; the trigger and
// the options live inside it, so their own clicks never race this listener.
document.addEventListener('click', (e) => {
  if (els.themePopover.hidden) return;
  const t = e.target;
  if (t && typeof t.closest === 'function' && t.closest('#theme-wrap')) return;
  setThemePopover(false);
});

// ---------- tipkovnica (keyboard shortcuts) ----------
//
// Space = play/pause, M = mute, ArrowUp/Down = volume ±5, L = lyrics panel,
// T = theme picker.
// ONE keydown listener, bound once; every shortcut reuses the matching
// button's own click path, so the keyboard and the pointer can never drift
// apart. Guards run before any consumption:
document.addEventListener('keydown', (e) => {
  const target = e.target;
  // Typing belongs to the focused field: a key pressed inside a form
  // control (or a contenteditable) must type into it -- 'm' in the request
  // form must not mute the stream. (Duck-typed: only Elements have
  // closest(); a document-level target has none and passes.)
  if (target && typeof target.closest === 'function' && target.closest('input, textarea, select, [contenteditable]')) return;
  // Modifier combos (Ctrl/Cmd+L bookmarks, Alt+letter menus, Shift+M caps)
  // keep their native meaning -- only bare keys are ours.
  if (e.ctrlKey || e.altKey || e.metaKey || e.shiftKey) return;
  if (e.key === 'Escape') {
    // The sleep and theme popovers are the floating overlays: Esc dismisses
    // whichever is open and hands focus back to its trigger. Consumed only
    // while one is open -- everywhere else Esc keeps its native meaning.
    if (!els.sleepPopover.hidden) {
      setSleepPopover(false);
      els.sleepButton.focus();
      e.preventDefault();
    } else if (!els.themePopover.hidden) {
      setThemePopover(false);
      els.themeButton.focus();
      e.preventDefault();
    }
    return;
  }
  if (e.key === ' ') {
    // A focused button/link must keep Space for itself: the browser
    // activates it natively, and hijacking the key would double-toggle the
    // player underneath the user's real target.
    if (target && typeof target.closest === 'function' && target.closest('button, a, [role="button"]')) return;
    e.preventDefault(); // consumed -- Space would otherwise scroll the page
    els.playButton.click(); // the exact existing play/pause path
    return;
  }
  const key = e.key.length === 1 ? e.key.toLowerCase() : e.key;
  if (key === 'm') {
    els.muteButton.click(); // the exact existing mute path (no default to suppress)
    return;
  }
  if (key === 'l') {
    els.lyricsToggle.click(); // the exact existing lyrics-toggle path
    return;
  }
  if (key === 't') {
    els.themeButton.click(); // the exact existing picker-open path
    return;
  }
  // While the theme popover is open AND focus sits inside its radiogroup,
  // the arrows belong to the radios (ARIA radio semantics) -- not to the
  // volume slider. Outside the popover the arrows keep their volume job.
  if (e.key === 'ArrowUp' || e.key === 'ArrowDown' || e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
    if (
      !els.themePopover.hidden &&
      target && typeof target.closest === 'function' &&
      target.closest('#theme-popover')
    ) {
      e.preventDefault(); // consumed -- the arrows would otherwise scroll the page
      moveThemeFocus(e.key);
      return;
    }
  }
  if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
    e.preventDefault(); // consumed -- the arrows would otherwise scroll the page
    const delta = e.key === 'ArrowUp' ? 5 : -5;
    els.volume.value = String(Math.max(0, Math.min(100, Number(els.volume.value) + delta)));
    applyVolume(); // applies + persists, exactly like dragging the slider
    // Focus the slider so its own aria feedback engages from here on: the
    // NEXT arrow press lands on the range input natively (fine ±1 stepping;
    // the ±5 jump is this shortcut's job, the slider is the fine control).
    els.volume.focus();
  }
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
  const mine = topListenedSeq.next();
  els.topError.hidden = true;
  try {
    const res = await fetch('/api/top-listened');
    if (!res.ok) throw new Error(res.status);
    const data = await res.json();
    if (!topListenedSeq.isNewest(mine)) return;
    renderTopListened(data);
  } catch {
    if (!topListenedSeq.isNewest(mine)) return;
    els.topList.replaceChildren();
    els.topEmpty.hidden = true;
    els.topError.hidden = false;
  }
}

// ---------- anketa (listener poll) ----------
//
// The listener-facing half of the polls backend: GET /api/polls/active +
// POST /api/polls/vote {id, option}. One active poll at a time; the card is
// hidden whenever the answer says there is none (or a vote answers 404).
// The tally is public data and is shown honestly -- counts, percentages and
// the total, never invented. Deployment note: on a PUBLIC station the owner
// must list /api/polls/active under config.web.publicPaths and
// /api/polls/vote under config.web.publicWritePaths for anonymous visitors
// (publicPaths is GET/HEAD-only by design, so the vote POST needs the write
// list). On a private station the browser's cached Basic-auth rides these
// same-origin fetches automatically, exactly like every other /api call the
// page already makes.

const pollsState = {
  poll: null,       // last rendered active poll ({id, question, options, votes, total, ...})
  votedIndex: null, // option this page load last voted for -- highlight only; the backend tracks no per-listener identity by design
  voting: false,    // one vote round-trip at a time (double-clicks share one ask)
  fetching: false,  // in-flight guard: the 12 s tick and the post-vote refresh share one ask
  renderedKey: '',  // identity of what is in the DOM -- unchanged data must not rebuild (focus churn)
};

// Slovenian pluralization for 'glas': 1 glas, 2 glasova (dual), 3-4 glasovi,
// 5+ glasov -- the 11/12/13 teens take the genitive like any 5+ count.
function votesLabel(n) {
  if (n === 1) return '1 glas';
  const mod100 = n % 100;
  if (mod100 === 2) return `${n} glasova`;
  if (mod100 === 3 || mod100 === 4) return `${n} glasovi`;
  return `${n} glasov`;
}

function setPollStatus(text, cls = '') {
  // role="status" on the element makes every outcome announce politely --
  // the same pattern the lyrics panel's #lyrics-status uses.
  els.pollStatus.textContent = text ?? '';
  els.pollStatus.className = `form-result ${cls}`.trim();
}

function hidePollCard() {
  pollsState.poll = null;
  pollsState.votedIndex = null;
  pollsState.renderedKey = '';
  // Leave nothing stale inside the hidden card -- the next open renders
  // from a clean slate.
  els.pollQuestion.textContent = '';
  els.pollOptions.replaceChildren();
  els.pollTotal.textContent = '';
  els.pollCard.hidden = true;
}

function pollOptionRow(poll, index) {
  const votes = Number(poll.votes?.[index]) || 0;
  const total = Number(poll.total) || 0;
  const pct = total > 0 ? Math.round((votes / total) * 100) : 0;

  const wrap = document.createElement('div');
  wrap.className = 'poll-option';

  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'btn-secondary'; // full-width via .poll-option CSS, ~44px touch target
  button.textContent = poll.options[index];
  button.setAttribute('aria-pressed', String(pollsState.votedIndex === index));
  button.addEventListener('click', () => votePollOption(index));
  wrap.appendChild(button);

  // Thin tally bar -- the same progress-bar pair the hero track progress uses.
  const bar = document.createElement('div');
  bar.className = 'progress-bar';
  bar.setAttribute('aria-hidden', 'true'); // the count line below already says the numbers
  const fill = document.createElement('div');
  fill.className = 'progress-fill';
  fill.style.width = `${pct}%`;
  bar.appendChild(fill);
  wrap.appendChild(bar);

  const count = document.createElement('p');
  count.className = 'poll-count';
  count.textContent = `${votesLabel(votes)} · ${pct} %`;
  wrap.appendChild(count);
  return wrap;
}

function renderPolls(poll) {
  const valid =
    poll && typeof poll.question === 'string' && poll.question && Array.isArray(poll.options) && poll.options.length > 0;
  if (!valid) {
    // Nothing open (or it closed between asks): hide the card entirely.
    hidePollCard();
    return;
  }
  if (pollsState.poll?.id !== poll.id) pollsState.votedIndex = null; // a new poll resets the highlight
  pollsState.poll = poll;
  // Skip the rebuild when nothing changed: a 12 s tick that re-renders an
  // identical poll would drop focus from a button the listener is on.
  const key = `${poll.id}|${(poll.votes ?? []).join(',')}|${poll.total}|${pollsState.votedIndex}`;
  if (key === pollsState.renderedKey && !els.pollCard.hidden) return;
  pollsState.renderedKey = key;

  els.pollQuestion.textContent = poll.question;
  els.pollOptions.replaceChildren(...poll.options.map((_, index) => pollOptionRow(poll, index)));
  els.pollTotal.textContent = `Skupaj: ${votesLabel(Number(poll.total) || 0)}`;
  els.pollCard.hidden = false;
}

async function fetchPolls() {
  if (pollsState.fetching) return;
  pollsState.fetching = true;
  try {
    const res = await fetch('/api/polls/active');
    if (!res.ok) return; // transient or auth-gated: keep last state, the tick retries
    const data = await res.json();
    renderPolls(data?.poll ?? null);
  } catch {
    // network hiccup -- nothing to say that the next tick won't say better
  } finally {
    pollsState.fetching = false;
  }
}

async function votePollOption(index) {
  const poll = pollsState.poll;
  if (!poll || pollsState.voting) return;
  pollsState.voting = true;
  const buttons = els.pollOptions.querySelectorAll('button');
  buttons.forEach((b) => { b.disabled = true; });
  try {
    const res = await fetch('/api/polls/vote', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: poll.id, option: index }),
    });
    if (res.status === 401 || res.status === 403) {
      // Anonymous visitor on a station that gates the vote route: listening
      // works, voting needs the same credentials -- say so, keep the buttons.
      setPollStatus('Za glasovanje se prijavite z enakimi poverilnicami kot za poslušanje.', 'is-warn');
      return;
    }
    if (res.status === 429) {
      const data = await res.json().catch(() => null);
      setPollStatus(data?.errors?.[0] ?? 'Glas lahko oddaš le vsakih 30 sekund.', 'is-warn');
      return;
    }
    if (res.status === 404) {
      // The poll closed while the card was open -- take the card down.
      hidePollCard();
      return;
    }
    if (!res.ok) {
      const data = await res.json().catch(() => null);
      setPollStatus(data?.errors?.[0] ?? `Glasovanje ni uspelo (napaka ${res.status}).`, 'is-err');
      return;
    }
    pollsState.votedIndex = index;
    setPollStatus('Glas oddan.', 'is-ok');
    // The POST answer carries only the summary tally ({total, leader,
    // leaderVotes}) -- the honest per-option counts come from one immediate
    // re-read of the active poll, which also folds in other listeners' votes.
    // (If the 12 s tick happens to be mid-flight, that answer suffices and
    // the next tick heals the counts either way.)
    await fetchPolls();
  } catch {
    setPollStatus('Glasovanje ni uspelo -- strežnik ni dosegljiv. Poskusi znova.', 'is-err');
  } finally {
    pollsState.voting = false;
    els.pollOptions.querySelectorAll('button').forEach((b) => { b.disabled = false; });
  }
}

// ---------- besedila (lyrics panel) ----------
//
// "Besedila": collapsible lyrics for the on-air track, fed by
// GET /api/lyrics/current (LRCLIB-backed server side, honest 503 while the
// feature is switched off). Not a tab -- selectTab() stays untouched; the
// panel folds out inside the hero, under the player status. Polling runs
// ONLY while the panel is open AND music is on air: 4 s while the station
// is still looking the song up (bounded to 10 asks), 15 s otherwise -- a
// late answer still heals the panel. Offsets are applied to the CLOCK,
// never to the lines (SUB/WAVE lesson): the station offset arrives per
// response, the device offset lives in localStorage and survives reloads.

const LYRICS_PENDING_MAX_TRIES = 10;
const LYRICS_PENDING_POLL_MS = 4000;
const LYRICS_POLL_MS = 15000;
const LYRICS_TICK_MS = 500;
const LYRICS_NUDGE_MS = 100;
const LYRICS_OFFSET_MAX_MS = 30000;
const LYRICS_DEVICE_OFFSET_KEY = 'lyrics-device-offset-ms';
const LYRICS_SCROLL_ECHO_MS = 1000; // our own scrollIntoView echoes a 'scroll' event
const LYRICS_USER_SCROLL_PAUSE_MS = 8000; // the user's scrolling wins over auto-centering, for a while

const lyricsState = {
  open: false,
  songId: null,
  synced: false,
  lines: [],
  source: null,
  pending: false,
  stationOffsetMs: 0,
  deviceOffsetMs: readLyricsDeviceOffset(),
  // internal bookkeeping
  disabled: false, // 503 lyrics-disabled: terminal for this page load
  fetched: false, // at least one answer arrived for the current track
  failed: false, // the last ask threw -- honest "unreachable" until the next one
  playedAtMs: null, // OWN copy: now-playing poll refreshes must not jitter the lyrics clock
  trackKey: null, // "artist — title" of the track this state describes
  epoch: 0, // boundary counter: answers that straddled a boundary are dropped
  pendingTries: 0,
  fetching: false,
  pollTimer: null,
  tickTimer: null,
  currentLine: -1,
  renderedLines: null, // identity of the lines array behind the rendered DOM
  lastProgrammaticScrollAt: 0,
  userScrollUntil: 0,
};

function readLyricsDeviceOffset() {
  let raw = 0;
  try {
    raw = Number.parseInt(localStorage.getItem(LYRICS_DEVICE_OFFSET_KEY) ?? '0', 10);
  } catch {
    return 0; // storage blocked -- the offset simply starts at zero
  }
  if (!Number.isFinite(raw)) return 0;
  return Math.max(-LYRICS_OFFSET_MAX_MS, Math.min(LYRICS_OFFSET_MAX_MS, raw));
}

function persistLyricsDeviceOffset(ms) {
  const clamped = Math.max(-LYRICS_OFFSET_MAX_MS, Math.min(LYRICS_OFFSET_MAX_MS, Math.round(ms) || 0));
  try {
    // 0 removes the key, exactly like the server's own offset table holds
    // only actually-corrected tracks.
    if (clamped === 0) localStorage.removeItem(LYRICS_DEVICE_OFFSET_KEY);
    else localStorage.setItem(LYRICS_DEVICE_OFFSET_KEY, String(clamped));
  } catch {
    // private mode: the nudge still applies for this session, just not beyond it
  }
  return clamped;
}

function formatLyricsOffset(ms) {
  // sl-SI decimal comma; U+2212 minus so the sign can't read as a hyphen
  const seconds = (Math.abs(ms) / 1000).toFixed(1).replace('.', ',');
  if (ms > 0) return `+${seconds} s`;
  if (ms < 0) return `\u2212${seconds} s`;
  return `${seconds} s`;
}

function renderLyricsOffsetValue() {
  els.lyricsOffsetValue.textContent = formatLyricsOffset(lyricsState.deviceOffsetMs);
  els.lyricsOffsetReset.disabled = lyricsState.deviceOffsetMs === 0; // nothing to reset at zero
}

function nudgeLyricsOffset(deltaMs) {
  const next = persistLyricsDeviceOffset(lyricsState.deviceOffsetMs + (deltaMs || 0));
  if (next === lyricsState.deviceOffsetMs) return; // clamped -- nothing moved
  lyricsState.deviceOffsetMs = next;
  renderLyricsOffsetValue();
  tickLyrics(); // re-highlight at once: corrections land on the clock, no refetch
}

function renderLyricsStatus(text, cls = '') {
  const value = text ?? '';
  if (els.lyricsStatus.hidden === !value && els.lyricsStatus.textContent === value) return; // no churn, no double screen-reader announce
  els.lyricsStatus.textContent = value;
  els.lyricsStatus.className = `lyrics-status ${cls}`.trim();
  els.lyricsStatus.hidden = !value;
}

function lyricLineEl(line) {
  const row = document.createElement('p');
  row.className = 'lyric-line';
  const text = typeof line?.text === 'string' ? line.text : '';
  if (text.trim()) {
    row.textContent = text;
  } else {
    // stamped but empty line: the singing pauses for an instrumental stretch
    const glyph = document.createElement('span');
    glyph.className = 'lyric-rest';
    glyph.textContent = '\u266A';
    glyph.setAttribute('aria-hidden', 'true');
    const label = document.createElement('span');
    label.className = 'sr-only';
    label.textContent = 'instrumentalni del';
    row.append(glyph, label);
  }
  return row;
}

function renderLyricsLines() {
  els.lyricsLines.replaceChildren(...lyricsState.lines.map(lyricLineEl));
  lyricsState.currentLine = -1; // tickLyrics() re-highlights on its next pass
}

function lyricsElapsedMs() {
  if (lyricsState.playedAtMs == null) return null;
  return Date.now() - lyricsState.playedAtMs + lyricsState.stationOffsetMs + lyricsState.deviceOffsetMs;
}

function currentLyricsLineIndex() {
  // The last stamped line whose startMs <= elapsed; a null-startMs line is
  // metadata and is never current.
  if (!lyricsState.synced || !lyricsState.lines.length) return -1;
  const elapsed = lyricsElapsedMs();
  if (elapsed == null) return -1;
  let current = -1;
  for (let i = 0; i < lyricsState.lines.length; i++) {
    const startMs = lyricsState.lines[i].startMs;
    if (typeof startMs === 'number' && Number.isFinite(startMs) && startMs <= elapsed) current = i;
  }
  return current;
}

function scrollLyricsTo(row) {
  if (!row) return;
  let behavior = 'smooth';
  try {
    if (typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches) behavior = 'auto';
  } catch { /* no matchMedia -- smooth stays */ }
  try {
    row.scrollIntoView({ block: 'center', behavior });
  } catch { /* engines without scroll options */ row.scrollIntoView(); }
  lyricsState.lastProgrammaticScrollAt = Date.now(); // anchor for the echo guard
}

function tickLyrics() {
  if (!lyricsState.open || !lyricsState.synced || !lyricsState.lines.length || lyricsState.playedAtMs == null) return;
  const current = currentLyricsLineIndex();
  if (current === lyricsState.currentLine) return; // DOM writes only when the line CHANGES
  lyricsState.currentLine = current;
  const rows = els.lyricsLines.children;
  for (let i = 0; i < rows.length; i++) {
    rows[i].classList.toggle('is-past', i < current);
    rows[i].classList.toggle('is-current', i === current);
    if (i === current) rows[i].setAttribute('aria-current', 'true');
    else rows[i].removeAttribute('aria-current');
  }
  if (current >= 0 && Date.now() >= lyricsState.userScrollUntil) scrollLyricsTo(rows[current]);
}

function startLyricsTick() {
  stopLyricsTick();
  lyricsState.tickTimer = setInterval(tickLyrics, LYRICS_TICK_MS);
}

function stopLyricsTick() {
  if (lyricsState.tickTimer != null) {
    clearInterval(lyricsState.tickTimer);
    lyricsState.tickTimer = null;
  }
}

function stopLyricsPoll() {
  if (lyricsState.pollTimer != null) {
    clearTimeout(lyricsState.pollTimer);
    lyricsState.pollTimer = null;
  }
}

function scheduleLyricsPoll() {
  stopLyricsPoll();
  if (!lyricsState.open || !trackIsPlaying || lyricsState.disabled) return;
  // 4 s while the station is still looking the song up (bounded), else 15 s.
  // Past the bound the status turns honest ("ni bilo mogo\u010De najti") but THIS
  // chain keeps running at 15 s -- a late-resolving lookup still heals the panel.
  const delay =
    lyricsState.pending && lyricsState.pendingTries < LYRICS_PENDING_MAX_TRIES ? LYRICS_PENDING_POLL_MS : LYRICS_POLL_MS;
  lyricsState.pollTimer = setTimeout(async () => {
    lyricsState.pollTimer = null;
    if (!lyricsState.open || !trackIsPlaying || lyricsState.disabled) return; // the chain ends here
    await fetchLyrics(); // the answer's handler re-arms the chain
  }, delay);
}

function refreshLyricsView() {
  // The single renderer: status, line list, offset row. The list only
  // rebuilds when the lines ARRAY identity changed (a refill assigned a new
  // array) -- a steady poll must not reset the highlight or fight the
  // user's scroll position.
  renderLyricsOffsetValue();
  if (lyricsState.lines !== lyricsState.renderedLines) {
    lyricsState.renderedLines = lyricsState.lines;
    renderLyricsLines();
  }
  const clockable = lyricsState.synced && lyricsState.lines.length > 0 && lyricsState.playedAtMs != null;
  els.lyricsOffset.hidden = !clockable; // nudging makes sense only against a clock
  let status = '';
  let cls = '';
  if (lyricsState.disabled) status = 'besedila so izklopljena';
  else if (!trackIsPlaying) status = 'Zdaj na etru ni skladbe -- besedila se poka\u017Eejo ob naslednji pesmi.';
  else if (lyricsState.failed && !lyricsState.lines.length) {
    status = 'besedila trenutno niso dosegljiva';
    cls = 'is-warn';
  } else if (!lyricsState.fetched) status = 'Nalagam besedila \u2026';
  else if (!lyricsState.lines.length && lyricsState.pending) {
    status = lyricsState.pendingTries >= LYRICS_PENDING_MAX_TRIES ? 'besedil ni bilo mogo\u010De najti' : 'i\u0161\u010Dem besedila \u2026';
  } else if (!lyricsState.lines.length) status = 'za to pesem ni besedil';
  else if (!lyricsState.synced) status = 'besedila (sinhronizacija ni na voljo)';
  else if (lyricsState.playedAtMs == null) status = 'neznani za\u010Detek predvajanja';
  renderLyricsStatus(status, cls);
}

function resetLyricsForNewTrack(playedAtMs, key) {
  lyricsState.trackKey = key ?? null;
  lyricsState.songId = null;
  lyricsState.synced = false;
  lyricsState.lines = [];
  lyricsState.source = null;
  lyricsState.pending = false;
  lyricsState.stationOffsetMs = 0;
  lyricsState.failed = false;
  lyricsState.fetched = false;
  lyricsState.pendingTries = 0;
  lyricsState.playedAtMs = playedAtMs ?? null;
  lyricsState.epoch += 1; // any answer still in flight describes the previous track
  stopLyricsPoll();
  refreshLyricsView();
  if (lyricsState.open && trackIsPlaying && !lyricsState.disabled) fetchLyrics();
}

function resetLyricsForNoMusic() {
  lyricsState.trackKey = null;
  lyricsState.songId = null;
  lyricsState.synced = false;
  lyricsState.lines = [];
  lyricsState.source = null;
  lyricsState.pending = false;
  lyricsState.stationOffsetMs = 0;
  lyricsState.failed = false;
  lyricsState.fetched = false;
  lyricsState.pendingTries = 0;
  lyricsState.playedAtMs = null;
  lyricsState.epoch += 1;
  stopLyricsPoll(); // no music -> no polling; the panel tells the truth and waits
  refreshLyricsView();
}

function applyLyrics(data) {
  const songId = typeof data?.songId === 'string' ? data.songId : null;
  const lines = Array.isArray(data?.lines) ? data.lines.filter((l) => l && typeof l.text === 'string') : [];
  const synced = Boolean(data?.synced);
  const pending = Boolean(data?.pending);
  // When the panel must actually REBUILD (not just update offsets):
  //  - the server moved to another track, or
  //  - a pending lookup resolved for the SAME songId (the first build had a
  //    real bug here: a same-songId answer after pending left the panel
  //    empty forever), or
  //  - plain lyrics got upgraded to synced ones, or
  //  - this is the first answer for the current track.
  const refill =
    !lyricsState.fetched ||
    songId !== lyricsState.songId ||
    (lyricsState.pending && !pending) ||
    (!lyricsState.synced && synced && lines.length > 0);
  const stationOffsetMs = Number(data?.offsetMs);
  lyricsState.songId = songId;
  lyricsState.source = typeof data?.source === 'string' ? data.source : null;
  lyricsState.stationOffsetMs = Number.isFinite(stationOffsetMs)
    ? Math.max(-LYRICS_OFFSET_MAX_MS, Math.min(LYRICS_OFFSET_MAX_MS, stationOffsetMs))
    : 0;
  lyricsState.pending = pending;
  lyricsState.pendingTries = pending ? lyricsState.pendingTries + 1 : 0;
  lyricsState.failed = false;
  lyricsState.fetched = true;
  if (refill) {
    lyricsState.synced = synced;
    lyricsState.lines = lines;
  }
  refreshLyricsView();
  tickLyrics(); // highlight wherever the song already is
  scheduleLyricsPoll(); // re-arm the chain with the delay the new state asks for
}

async function fetchLyrics() {
  if (lyricsState.fetching || lyricsState.disabled || !lyricsState.open || !trackIsPlaying) return;
  lyricsState.fetching = true; // in-flight guard: poll ticks and opens share one ask
  const epoch = lyricsState.epoch;
  try {
    const res = await fetch('/api/lyrics/current');
    if (epoch !== lyricsState.epoch) {
      // a boundary passed while we were asking: the answer describes the
      // previous track -- hand the ask over to the current one (one hop; the
      // fresh epoch keeps this from looping)
      if (lyricsState.open && trackIsPlaying && !lyricsState.disabled) fetchLyrics();
      return;
    }
    if (res.status === 503) {
      // Honest 503: lyrics are switched off server-side. Terminal for this
      // page load -- no refetch on reopen, no polling, no toasts.
      lyricsState.disabled = true;
      lyricsState.failed = false;
      stopLyricsPoll();
      refreshLyricsView();
      return;
    }
    if (!res.ok) throw new Error(`lyrics ${res.status}`);
    const data = await res.json();
    if (epoch !== lyricsState.epoch) {
      if (lyricsState.open && trackIsPlaying && !lyricsState.disabled) fetchLyrics();
      return;
    }
    applyLyrics(data);
  } catch {
    if (epoch === lyricsState.epoch) {
      lyricsState.failed = true;
      refreshLyricsView(); // 'besedila trenutno niso dosegljiva' -- the chain retries
      scheduleLyricsPoll();
    }
  } finally {
    lyricsState.fetching = false;
  }
}

function setLyricsPanelOpen(open) {
  lyricsState.open = Boolean(open);
  els.lyricsPanel.hidden = !lyricsState.open;
  els.lyricsToggle.setAttribute('aria-expanded', String(lyricsState.open));
  if (lyricsState.open) {
    refreshLyricsView();
    startLyricsTick();
    if (!lyricsState.disabled && trackIsPlaying) fetchLyrics(); // a fresh open deserves a fresh answer
  } else {
    stopLyricsTick();
    stopLyricsPoll();
  }
}

// Called as the ONE new line at the end of renderNowPlaying(): the panel
// keeps its OWN playedAt copy (poll refreshes must not jitter the clock)
// and starts/stops its lifecycle at track boundaries.
function lyricsOnNowPlaying(data) {
  const track = data?.track;
  if (!track?.title) {
    resetLyricsForNoMusic(); // spoken segment / dead air
    return;
  }
  const key = trackKey(track.artist ?? '', track.title);
  if (key === lyricsState.trackKey) return; // same track: the clock keeps running untouched
  const playedAt = track.playedAt ? new Date(track.playedAt).getTime() : null;
  resetLyricsForNewTrack(Number.isFinite(playedAt) ? playedAt : null, key);
}

els.lyricsToggle.addEventListener('click', () => setLyricsPanelOpen(!lyricsState.open));
els.lyricsOffsetDown.addEventListener('click', () => nudgeLyricsOffset(-LYRICS_NUDGE_MS));
els.lyricsOffsetUp.addEventListener('click', () => nudgeLyricsOffset(LYRICS_NUDGE_MS));
els.lyricsOffsetReset.addEventListener('click', () => nudgeLyricsOffset(-lyricsState.deviceOffsetMs)); // ponastavi -> 0

// Scrolling discipline: the user's scrolling wins over auto-centering for
// 8 s (wheel/touch); our own scrollIntoView echoes a 'scroll' event, so
// echoes within 1 s of the programmatic scroll are not mistaken for the user.
function pauseLyricsAutoScroll() {
  lyricsState.userScrollUntil = Date.now() + LYRICS_USER_SCROLL_PAUSE_MS;
}
els.lyricsLines.addEventListener('wheel', pauseLyricsAutoScroll, { passive: true });
els.lyricsLines.addEventListener('touchstart', pauseLyricsAutoScroll, { passive: true });
els.lyricsLines.addEventListener('scroll', () => {
  if (Date.now() - lyricsState.lastProgrammaticScrollAt < LYRICS_SCROLL_ECHO_MS) return; // our own echo
  pauseLyricsAutoScroll();
});

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
fetchPolls();
setInterval(fetchNowPlaying, POLL_MS);
setInterval(fetchHistory, POLL_MS);
setInterval(fetchUpcoming, POLL_MS);
setInterval(fetchPolls, POLL_MS); // anketa: same cadence as the hero refresh
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
