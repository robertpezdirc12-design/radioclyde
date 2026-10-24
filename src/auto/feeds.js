// Deterministic content sources for the autoRadio "rubrikes" (service
// segments): today's weather from ARSO (official Slovenian Environment
// Agency), sports headlines from RTV Slovenija, and an "on this day"
// segment from Wikidata -- all real data, no language model, every fetch
// with a hard timeout and a null-on-failure contract so the show degrades
// to "no rubric today" instead of failing.
//
//   ARSO observations (Slovenian, ~20 stations, updates ~30 min):
//     https://meteo.arso.gov.si/uploads/probase/www/observ/surface/text/sl/
//       observation_si_latest.rss
//     Item titles look like "CELJE: Zmerno obla\u010dno, 18 \u00b0C."
//
//   RTV Slovenija sport RSS (fresh headlines):
//     https://www.rtvslo.si/sport/rss
//
//   Wikidata SPARQL (births/deaths on today's date, Slovenian labels only):
//     https://query.wikidata.org/sparql
//
// Everything is cached in-process for a configurable TTL so prewarm +
// director + retries never hammer the sources, and every response is
// shaped into plain template values ({station}, {condition}, {temp},
// {headlines}, {year}, {name}, ...) that renderSlot() can substitute.
import { XMLParser } from 'fast-xml-parser';
import { config } from '../config/index.js';
import { pickOnThisDayMusic } from './onThisDayFacts.js';
import { createLogger } from '../lib/logger.js';
import { pickQuizQuestions } from './quizFacts.js';
import { activePollSummary } from '../server/pollsStore.js';
import { readRequests } from '../server/requestsStore.js';

const log = createLogger('station');

const ARSO_OBSERVATIONS_RSS =
  'https://meteo.arso.gov.si/uploads/probase/www/observ/surface/text/sl/observation_si_latest.rss';
const RTV_SPORT_RSS = 'https://www.rtvslo.si/sport/rss';
const RTV_NEWS_RSS = 'https://www.rtvslo.si/feeds/novice.xml';
const WIKIDATA_SPARQL = 'https://query.wikidata.org/sparql';
const USER_AGENT = 'RadioClyde-autoRadio/1.0 (self-hosted radio automation; deterministic templates)';

const parser = new XMLParser({ ignoreAttributes: true });

// ---------------------------------------------------------------------------
// small fetch/cache helpers
// ---------------------------------------------------------------------------

const cache = new Map(); // key -> { at, value }

function cacheKey(parts) {
  return parts.join('|');
}

function cacheGet(key, ttlMs) {
  const hit = cache.get(key);
  if (!hit) return undefined;
  if (Date.now() - hit.at > ttlMs) {
    cache.delete(key);
    return undefined;
  }
  return hit.value;
}

function cacheSet(key, value) {
  cache.set(key, { at: Date.now(), value });
}

async function fetchText(url, timeoutMs) {
  const res = await fetch(url, {
    headers: { 'User-Agent': USER_AGENT, Accept: 'application/rss+xml, application/xml, text/xml, application/json;q=0.9, */*;q=0.8' },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return res.text();
}

function rssItems(xmlText) {
  const doc = parser.parse(xmlText);
  const channel = doc?.rss?.channel ?? doc?.['rdf:RDF']?.channel;
  const raw = channel?.item;
  if (!raw) return [];
  return (Array.isArray(raw) ? raw : [raw])
    .map((item) => ({
      title: String(item.title ?? '').trim(),
      description: String(item.description ?? '').trim(),
      pubDate: String(item.pubDate ?? '').trim(),
    }))
    .filter((item) => item.title.length > 0);
}

// ---------------------------------------------------------------------------
// weather: ARSO observations
// ---------------------------------------------------------------------------

// "CELJE: Zmerno obla\u010dno, 18 \u00b0C." / "KREDARICA: -2 \u00b0C." / "CELJE: 12 \u00b0C." / "NOVO MESTO: Jasno."
// The comma before the temperature is optional -- ARSO items without a
// condition ("CELJE: 12 \u00b0C.") or without a temperature ("NOVO MESTO: Jasno.")
// are both everyday shapes.
const ARSO_ITEM_RE = /^(?<station>[^:]+?):\s*(?<condition>.*?)(?:,?\s*(?<temp>-?\d+(?:[.,]\d+)?)\s*\u00b0C)?\.?\s*$/u;

export function parseArsoItemTitle(title) {
  const match = ARSO_ITEM_RE.exec(title.trim());
  if (!match) return null;
  const { station, condition, temp } = match.groups;
  return {
    station: station.trim().toUpperCase(),
    condition: (condition ?? '').trim(),
    temp: temp != null ? Number(String(temp).replace(',', '.')) : null,
  };
}

// Picks the ARSO item for the configured station. Slovenian station names
// decline ("Ljubljana" -> "Katarina nad Ljubljano"), so plain contains() on
// the full name would match only the airport. Instead: exact -> startsWith
// -> collect candidates from EVERY prefix level of the wanted name (full
// name down to 4 chars) and take the SHORTEST station overall — the close
// city-area station beats the airport's long official name, while an
// unambiguous name ("Celje") still matches exactly.
export function pickArsoItem(items, wanted) {
  const wantedUpper = String(wanted ?? '').trim().toUpperCase();
  if (!wantedUpper) return items[0] ?? null;
  const parsed = items
    .map((item) => ({ item, data: parseArsoItemTitle(item.title) }))
    .filter((entry) => entry.data);
  const exact = parsed.find((entry) => entry.data.station === wantedUpper);
  if (exact) return exact.item;
  const startsWith = parsed.filter((entry) => entry.data.station.startsWith(wantedUpper));
  if (startsWith.length > 0) return startsWith[0].item;
  const pool = new Map();
  for (let stem = wantedUpper.length; stem >= 4; stem--) {
    const needle = wantedUpper.slice(0, stem);
    for (const entry of parsed) {
      if (entry.data.station.includes(needle)) pool.set(entry.item.title, entry);
    }
  }
  if (pool.size === 0) return null;
  return [...pool.values()].sort((a, b) => a.data.station.length - b.data.station.length)[0].item;
}

export async function fetchArsoCurrentWeather({ station, timeoutMs = 10_000, ttlMs = 15 * 60_000 } = {}) {
  const key = cacheKey(['arso', station]);
  const hit = cacheGet(key, ttlMs);
  if (hit !== undefined) return hit;
  try {
    const xml = await fetchText(ARSO_OBSERVATIONS_RSS, timeoutMs);
    const items = rssItems(xml);
    const chosen = pickArsoItem(items, station ?? 'Ljubljana');
    if (!chosen) {
      log(`feeds/arso: no station matching "${station}" in ${items.length} item(s) -- weather rubric airs its offline line.`);
      cacheSet(key, null);
      return null;
    }
    const data = parseArsoItemTitle(chosen.title);
    const value = data ? { source: 'arso', ...data } : null;
    cacheSet(key, value);
    return value;
  } catch (err) {
    log(`feeds/arso: fetch failed (${err.message}) -- weather rubric airs its offline line.`);
    return null;
  }
}

// ---------------------------------------------------------------------------
// sport: RTV Slovenija headlines
// ---------------------------------------------------------------------------

export function joinSlovenianHeadlines(titles) {
  const cleaned = titles.map((t) => t.trim().replace(/[.\s]+$/, ''));
  if (cleaned.length === 0) return '';
  return `${cleaned.join('. ')}.`;
}

export async function fetchSportHeadlines({ limit = 4, timeoutMs = 10_000, ttlMs = 30 * 60_000 } = {}) {
  const key = cacheKey(['rtv-sport', limit]);
  const hit = cacheGet(key, ttlMs);
  if (hit !== undefined) return hit;
  try {
    const xml = await fetchText(RTV_SPORT_RSS, timeoutMs);
    const titles = rssItems(xml).map((item) => item.title);
    if (titles.length === 0) {
      log('feeds/rtv-sport: empty feed -- sport rubric airs its offline line.');
      cacheSet(key, null);
      return null;
    }
    const value = { source: 'rtv', headlines: joinSlovenianHeadlines(titles.slice(0, limit)), count: Math.min(limit, titles.length) };
    cacheSet(key, value);
    return value;
  } catch (err) {
    log(`feeds/rtv-sport: fetch failed (${err.message}) -- sport rubric airs its offline line.`);
    return null;
  }
}

// ---------------------------------------------------------------------------
// news: RTV Slovenija headlines
// ---------------------------------------------------------------------------

export async function fetchNewsHeadlines({ limit = 3, timeoutMs = 10_000, ttlMs = 30 * 60_000 } = {}) {
  const key = cacheKey(['rtv-news', limit]);
  const hit = cacheGet(key, ttlMs);
  if (hit !== undefined) return hit;
  try {
    const xml = await fetchText(RTV_NEWS_RSS, timeoutMs);
    const titles = rssItems(xml).map((item) => item.title);
    if (titles.length === 0) {
      log('feeds/rtv-news: empty feed -- news rubric airs its offline line.');
      cacheSet(key, null);
      return null;
    }
    const value = { source: 'rtv', headlines: joinSlovenianHeadlines(titles.slice(0, limit)), count: Math.min(limit, titles.length) };
    cacheSet(key, value);
    return value;
  } catch (err) {
    log(`feeds/rtv-news: fetch failed (${err.message}) -- news rubric airs its offline line.`);
    return null;
  }
}

// ---------------------------------------------------------------------------
// on this day: Wikidata births/deaths with Slovenian labels
// ---------------------------------------------------------------------------

function onThisDaySparql(month, day) {
  // No ORDER BY here: sorting forces WDQS to materialize tens of thousands
  // of intermediate rows (every human born/died on this date in history)
  // and reliably blows past request timeouts. We take the LIMIT-ed stream,
  // then sort deterministically in Node.
  return `SELECT ?item ?year ?kind WHERE {
  {
    ?item wdt:P31 wd:Q5 ; wdt:P569 ?d .
    BIND(YEAR(?d) AS ?year) BIND("birth" AS ?kind)
    FILTER(MONTH(?d) = ${month} && DAY(?d) = ${day})
  }
  UNION
  {
    ?item wdt:P31 wd:Q5 ; wdt:P570 ?d .
    BIND(YEAR(?d) AS ?year) BIND("death" AS ?kind)
    FILTER(MONTH(?d) = ${month} && DAY(?d) = ${day})
  }
}
LIMIT 600`;
}

// P4 #19 ("Na današnji dan v glasbi"): same shape as the general query, but
// the person must hold an occupation that is (a subclass of) Q639669
// "musician" -- singers, guitarists, drummers, composers, ... The path
// wdt:P106/wdt:P279* keeps the query one template; everything else (LIMIT
// 600, no ORDER BY, Node-side sort) follows the general query's live-verified
// pattern, and both share the entity-labels + interleave pipeline below.
function onThisDayMusicSparql(month, day) {
  return `SELECT ?item ?year ?kind WHERE {
  {
    ?item wdt:P31 wd:Q5 ; wdt:P569 ?d ; wdt:P106 ?job .
    ?job wdt:P279* wd:Q639669 .
    BIND(YEAR(?d) AS ?year) BIND("birth" AS ?kind)
    FILTER(MONTH(?d) = ${month} && DAY(?d) = ${day})
  }
  UNION
  {
    ?item wdt:P31 wd:Q5 ; wdt:P570 ?d ; wdt:P106 ?job .
    ?job wdt:P279* wd:Q639669 .
    BIND(YEAR(?d) AS ?year) BIND("death" AS ?kind)
    FILTER(MONTH(?d) = ${month} && DAY(?d) = ${day})
  }
}
LIMIT 600`;
}

const FEMALE_QID = 'Q6581072';
const MALE_QID = 'Q6581097';

async function fetchEntityLabelsAndSex(ids, timeoutMs) {
  const out = new Map();
  for (let i = 0; i < ids.length; i += 50) {
    const chunk = ids.slice(i, i + 50);
    const url =
      `https://www.wikidata.org/w/api.php?action=wbgetentities&ids=${chunk.join('|')}` +
      `&props=labels%7Cclaims&languages=sl&format=json`;
    const res = await fetch(url, {
      headers: { 'User-Agent': USER_AGENT },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status} from Wikidata entities API`);
    const json = await res.json();
    for (const [id, entity] of Object.entries(json?.entities ?? {})) {
      const label = entity?.labels?.sl?.value ?? null;
      const genderClaim = entity?.claims?.P21?.[0]?.mainsnak?.datavalue?.value?.id ?? null;
      const sex = genderClaim === FEMALE_QID ? 'female' : genderClaim === MALE_QID ? 'male' : 'unknown';
      out.set(id, { label, sex });
    }
  }
  return out;
}

// Interleaves the two kinds (newest-first each) so a limit of 2 yields one
// birth and one death when both exist; deterministic by construction.
export function interleaveOnThisDay(rows, limit) {
  const births = rows.filter((r) => r.kind === 'birth');
  const deaths = rows.filter((r) => r.kind === 'death');
  const out = [];
  for (let i = 0; out.length < limit && (births[i] || deaths[i]); i++) {
    if (births[i]) out.push(births[i]);
    if (out.length < limit && deaths[i]) out.push(deaths[i]);
  }
  return out;
}

// Shared pipeline behind fetchOnThisDay + fetchOnThisDayMusic: phase 1 WDQS
// (date-filtered item stream, sorted deterministically here -- newest first,
// then by entity id), phase 2 entities API (Slovenian labels + gender).
async function fetchOnThisDayBySparql({ sparql, month, day, limit, timeoutMs, cacheKey, ttlMs, label }) {
  const hit = cacheGet(cacheKey, ttlMs);
  if (hit !== undefined) return hit;
  try {
    const url = `${WIKIDATA_SPARQL}?query=${encodeURIComponent(sparql)}&format=json`;
    const res = await fetch(url, {
      headers: { 'User-Agent': USER_AGENT, Accept: 'application/sparql-results+json' },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status} from Wikidata`);
    const json = await res.json();
    const rows = (json?.results?.bindings ?? [])
      .map((b) => ({
        id: String(b.item?.value ?? '').split('/').pop(),
        year: parseInt(b.year?.value, 10),
        kind: b.kind?.value,
      }))
      .filter((row) => row.id && Number.isFinite(row.year))
      .sort((a, b) => (b.year - a.year) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    if (rows.length === 0) {
      log(`feeds/wikidata: no events for this date -- ${label} rubric falls back offline.`);
      cacheSet(cacheKey, null);
      return null;
    }

    // Phase 2 (entities API): Slovenian labels + gender. Enough candidates
    // that at least `limit` of them almost surely carry an sl label.
    const candidateCount = Math.max(limit * 12, 24);
    const labels = await fetchEntityLabelsAndSex(
      rows.slice(0, candidateCount).map((row) => row.id),
      timeoutMs
    );
    const events = [];
    for (const row of rows) {
      const entity = labels.get(row.id);
      if (!entity?.label) continue; // no Slovenian label -> we would have to read foreign text
      events.push({ ...row, name: entity.label, sex: entity.sex });
      if (events.length >= candidateCount) break;
    }
    const value = events.length === 0 ? null : { source: 'wikidata', date: `${month}/${day}`, events: interleaveOnThisDay(events, limit) };
    if (!value) log(`feeds/wikidata: no Slovenian-labelled events for this date -- ${label} rubric falls back offline.`);
    cacheSet(cacheKey, value);
    return value;
  } catch (err) {
    log(`feeds/wikidata: query failed (${err.message}) -- ${label} rubric falls back offline.`);
    return null;
  }
}

// Resolves the "on this day" target date from the optional yyyy-mm-dd arg.
function onThisDayTargetDate(date) {
  const [year, month, day] = String(date ?? '').split('-').map((part) => parseInt(part, 10));
  return {
    month: Number.isFinite(month) ? month : new Date().getMonth() + 1,
    day: Number.isFinite(day) ? day : new Date().getDate(),
  };
}

export async function fetchOnThisDay({ date, limit = 2, timeoutMs = 15_000, ttlMs = 6 * 60 * 60_000 } = {}) {
  const { month, day } = onThisDayTargetDate(date);
  return fetchOnThisDayBySparql({
    sparql: onThisDaySparql(month, day),
    month,
    day,
    limit,
    timeoutMs,
    cacheKey: cacheKey(['onthisday', month, day, limit]),
    ttlMs,
    label: 'obzorje',
  });
}

// P4 #19: "Na današnji dan v glasbi" -- same pipeline, musician-filtered
// SPARQL, its own cache namespace. Nothing else changes (same skip-not-fail
// contract, same Slovenian-labels-only rule).
export async function fetchOnThisDayMusic({ date, limit = 2, timeoutMs = 15_000, ttlMs = 6 * 60 * 60_000 } = {}) {
  const { month, day } = onThisDayTargetDate(date);
  return fetchOnThisDayBySparql({
    sparql: onThisDayMusicSparql(month, day),
    month,
    day,
    limit,
    timeoutMs,
    cacheKey: cacheKey(['onthisdaymusic', month, day, limit]),
    ttlMs,
    label: 'obzorjeGlasba',
  });
}

// ---------------------------------------------------------------------------
// unified rubric collection -- what produce.js / previewAutoShow.js call
// ---------------------------------------------------------------------------

export function rubricSettings() {
  const cfg = config.autoRadio?.rubrics ?? {};
  return {
    station: cfg.station ?? 'Ljubljana',
    newsLimit: cfg.newsLimit ?? 3,
    sportLimit: cfg.sportLimit ?? 4,
    onThisDayLimit: cfg.onThisDayLimit ?? 2,
    onThisDayMusicLimit: cfg.onThisDayMusicLimit ?? 2,
    // P4 #22: questions per show from the local quiz corpus; 0 disables the
    // quiz content and falls back to the legacy year-guess quizIntro/quizReveal.
    quizCount: cfg.quizCount ?? 1,
    // P4 #26 listener shouts: how many freshly-approved entries may air and
    // how old an approval may be to still count as "fresh" (hours). 0
    // disables the rubric's content entirely.
    listenerLimit: cfg.listenerLimit ?? 2,
    listenerWindowHours: cfg.listenerWindowHours ?? 12,
    timeoutSeconds: cfg.timeoutSeconds ?? 10,
  };
}

// Fetches every enabled rubric in parallel; returns a plain object the
// script builder understands. A rubric that fails (or is disabled/offline)
// simply comes back null and its segment is skipped -- music keeps playing.
// (The "zanimivosti" rubric is NOT collected here: its artist half needs the
// tracklist, so auto/produce.js calls collectArtistTrivia() itself and stores
// the result as rubricData.trivia.)
//
// P4 #22: the "kviz" rubric is the one exception to "offline -> null": its
// content comes from the local quiz corpus (auto/quizFacts.js), so it works
// with zero network and is collected in the offline branch too.
// P4 #26: the "poslusalci" rubric -- freshly approved listener requests and
// dedications (server/requestsStore.js). The studio approves, the air reads:
// this is the Aiir Studio-Inbox / listener-driven-radio pattern from the
// research, wired to the queue the station already moderates. Honesty
// rules:
//   - ONLY status 'approved' entries are mentioned (pending stays pending),
//   - only approvals inside the freshness window count -- updatedAt is the
//     approval moment (stale approvals would tease songs long played; the
//     store has no played flag),
//   - dedication messages are truncated to 160 chars (TTS-friendly, and
//     never a listener's whole paragraph on air),
//   - the request's own words are NEVER edited, just cut with '...'.
// Local file -> zero network -> collected in the offline branch too, like
// quiz/poll. No fresh approvals -> null -> no segment (skip-not-fail).
export function collectListenerShout({ limit, windowHours } = {}) {
  const settings = rubricSettings();
  const maxItems = limit ?? settings.listenerLimit;
  const hours = windowHours ?? settings.listenerWindowHours;
  if (maxItems <= 0 || hours <= 0) return null;
  const cutoff = Date.now() - hours * 60 * 60_000;
  let entries;
  try {
    entries = readRequests();
  } catch {
    return null; // fail-open: an unreadable store never breaks a show
  }
  const approvedAt = (e) => Date.parse(e.updatedAt ?? e.createdAt ?? '') || 0;
  const created = (e) => Date.parse(e.createdAt ?? '') || 0;
  const fresh = entries
    .filter((e) => e.status === 'approved' && approvedAt(e) >= cutoff)
    // Deterministic order: approval time desc, then creation time desc as
    // the tie-break (same-millisecond approvals stay reproducible).
    .sort((a, b) => approvedAt(b) - approvedAt(a) || created(b) - created(a))
    .slice(0, maxItems);
  const shouts = fresh.map((e) =>
    e.type === 'dedication'
      ? {
          kind: 'dedication',
          message: e.message.length > 160 ? `${e.message.slice(0, 160).trimEnd()}...` : e.message,
          from: e.from ?? '',
        }
      : { kind: 'request', artist: e.artist ?? '', title: e.title ?? '', from: e.from ?? '' }
  );
  return shouts.length ? { shouts } : null;
}

export async function collectRubricData({ names = [], offline = false, date, seed } = {}) {
  const settings = rubricSettings();
  const quizSeed = seed ?? date ?? 'quiz';
  // P4 #28: the local "na današnji dan v glasbi" corpus shares the Wikidata
  // rubric's date window, so resolve month/day once here for both paths.
  const [, obzorjeMonth, obzorjeDay] = String(date ?? '').split('-').map((part) => parseInt(part, 10));
  const obzorjeTarget = {
    month: Number.isFinite(obzorjeMonth) ? obzorjeMonth : new Date().getMonth() + 1,
    day: Number.isFinite(obzorjeDay) ? obzorjeDay : new Date().getDate(),
  };
  const localMusic = () =>
    names.includes('onthisdaymusic')
      ? pickOnThisDayMusic({ month: obzorjeTarget.month, day: obzorjeTarget.day, limit: settings.onThisDayMusicLimit, seed: quizSeed })
      : null;
  // P4 #29 "vreme brez omrežja": the station name is config (always known),
  // the weather facts are not -- so a dead ARSO no longer drops the rubric
  // but airs an honest offline line instead (templates.weatherOffline, no
  // fabricated data; scriptBuilder renders source 'fallback' via the
  // weatherOffline slot). Respecting `names` keeps the rubric opt-in.
  const weatherFallback = () =>
    names.includes('weather') ? { source: 'fallback', station: settings.station } : null;
  // P4 #30 "po\u0161tene offline vrstice": novice, \u0161port and obzorje get the
  // same contract as vreme -- the rubric promised by the brief always airs,
  // but a dead/empty source can only ever produce an honest line ({ source:
  // 'fallback' }), never invented headlines. The shape stays deliberately
  // bare: any real content would have to come from the source itself.
  const newsFallback = () => (names.includes('news') ? { source: 'fallback' } : null);
  const sportFallback = () => (names.includes('sport') ? { source: 'fallback' } : null);
  const onThisDayFallback = () => (names.includes('onthisday') ? { source: 'fallback' } : null);
  const quiz = names.includes('quiz') && settings.quizCount > 0
    ? { questions: pickQuizQuestions(settings.quizCount, quizSeed) }
    : null;
  // P4 #25 "anketa": the active listener poll from the LOCAL polls store --
  // zero network, so like the quiz it is collected in the offline branch
  // too. No open poll simply yields null and the segment skips.
  const poll = names.includes('poll') ? activePollSummary() : null;
  // P4 #26 "poslusalci": freshly approved requests/dedications, local file.
  const listeners = names.includes('listeners') ? collectListenerShout() : null;
  if (offline) {
    log('feeds: rubrics skipped (offline mode); glasba fills from its local corpus (P4 #28), vreme/novice/\u0161port/obzorje air their honest offline lines (P4 #29/#30).');
    return { weather: weatherFallback(), news: newsFallback(), sport: sportFallback(), onThisDay: onThisDayFallback(), onThisDayMusic: localMusic(), quiz, poll, listeners, offline: true };
  }
  const timeoutMs = settings.timeoutSeconds * 1000;
  const wants = (rubric) => names.includes(rubric);
  const [weather, news, sport, onThisDay, onThisDayMusic] = await Promise.all([
    wants('weather') ? fetchArsoCurrentWeather({ station: settings.station, timeoutMs }) : null,
    wants('news') ? fetchNewsHeadlines({ limit: settings.newsLimit, timeoutMs }) : null,
    wants('sport') ? fetchSportHeadlines({ limit: settings.sportLimit, timeoutMs }) : null,
    wants('onthisday') ? fetchOnThisDay({ date, limit: settings.onThisDayLimit, timeoutMs }) : null,
    wants('onthisdaymusic') ? fetchOnThisDayMusic({ date, limit: settings.onThisDayMusicLimit, timeoutMs }) : null,
  ]);
  // P4 #28: Wikidata stays the primary source, but a dead router, a timeout
  // or a legitimately empty date no longer kills the rubric -- the local
  // corpus fills the gap with the same event shape. The network result wins
  // whenever it actually has events.
  const musicWithFallback =
    onThisDayMusic?.events?.length ? onThisDayMusic : (wants('onthisdaymusic') ? localMusic() : null);
  // P4 #29: same contract for vreme -- ARSO wins whenever it answers, the
  // honest offline line covers a dead/empty answer (fetch failure, station
  // miss, cached null) so the rubric promised in the brief always airs.
  const weatherWithFallback = weather ?? weatherFallback();
  // P4 #30: the same contract for novice/\u0161port -- RTV wins whenever it
  // answers, the honest offline line covers a dead/empty answer. For
  // obzorje the line also covers a legitimately event-less answer (an empty
  // archive is honest too: there was simply nothing we could read on air),
  // while a healthy Wikidata response with events keeps winning.
  const newsWithFallback = news ?? newsFallback();
  const sportWithFallback = sport ?? sportFallback();
  const onThisDayWithFallback = onThisDay?.events?.length ? onThisDay : onThisDayFallback();
  return { weather: weatherWithFallback, news: newsWithFallback, sport: sportWithFallback, onThisDay: onThisDayWithFallback, onThisDayMusic: musicWithFallback, quiz, poll, listeners, offline: false };
}
