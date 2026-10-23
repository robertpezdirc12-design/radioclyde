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
import { createLogger } from '../lib/logger.js';

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
      log(`feeds/arso: no station matching "${station}" in ${items.length} item(s) -- weather rubric skipped.`);
      cacheSet(key, null);
      return null;
    }
    const data = parseArsoItemTitle(chosen.title);
    const value = data ? { source: 'arso', ...data } : null;
    cacheSet(key, value);
    return value;
  } catch (err) {
    log(`feeds/arso: fetch failed (${err.message}) -- weather rubric skipped.`);
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
      log('feeds/rtv-sport: empty feed -- sport rubric skipped.');
      cacheSet(key, null);
      return null;
    }
    const value = { source: 'rtv', headlines: joinSlovenianHeadlines(titles.slice(0, limit)), count: Math.min(limit, titles.length) };
    cacheSet(key, value);
    return value;
  } catch (err) {
    log(`feeds/rtv-sport: fetch failed (${err.message}) -- sport rubric skipped.`);
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
      log('feeds/rtv-news: empty feed -- news rubric skipped.');
      cacheSet(key, null);
      return null;
    }
    const value = { source: 'rtv', headlines: joinSlovenianHeadlines(titles.slice(0, limit)), count: Math.min(limit, titles.length) };
    cacheSet(key, value);
    return value;
  } catch (err) {
    log(`feeds/rtv-news: fetch failed (${err.message}) -- news rubric skipped.`);
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

export async function fetchOnThisDay({ date, limit = 2, timeoutMs = 15_000, ttlMs = 6 * 60 * 60_000 } = {}) {
  const [year, month, day] = String(date ?? '').split('-').map((part) => parseInt(part, 10));
  const targetMonth = Number.isFinite(month) ? month : new Date().getMonth() + 1;
  const targetDay = Number.isFinite(day) ? day : new Date().getDate();
  const key = cacheKey(['onthisday', targetMonth, targetDay, limit]);
  const hit = cacheGet(key, ttlMs);
  if (hit !== undefined) return hit;
  try {
    // Phase 1 (WDQS): the date-filtered item stream. Deterministically
    // sorted here -- newest first, then by entity id.
    const url = `${WIKIDATA_SPARQL}?query=${encodeURIComponent(onThisDaySparql(targetMonth, targetDay))}&format=json`;
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
      log('feeds/wikidata: no events for this date -- obzorje rubric skipped.');
      cacheSet(key, null);
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
    const value = events.length === 0 ? null : { source: 'wikidata', date: `${targetMonth}/${targetDay}`, events: interleaveOnThisDay(events, limit) };
    if (!value) log('feeds/wikidata: no Slovenian-labelled births/deaths for this date -- obzorje rubric skipped.');
    cacheSet(key, value);
    return value;
  } catch (err) {
    log(`feeds/wikidata: query failed (${err.message}) -- obzorje rubric skipped.`);
    return null;
  }
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
    timeoutSeconds: cfg.timeoutSeconds ?? 10,
  };
}

// Fetches every enabled rubric in parallel; returns a plain object the
// script builder understands. A rubric that fails (or is disabled/offline)
// simply comes back null and its segment is skipped -- music keeps playing.
export async function collectRubricData({ names = [], offline = false, date } = {}) {
  if (offline) {
    log('feeds: rubrics skipped (offline mode).');
    return { weather: null, news: null, sport: null, onThisDay: null, offline: true };
  }
  const settings = rubricSettings();
  const timeoutMs = settings.timeoutSeconds * 1000;
  const wants = (rubric) => names.includes(rubric);
  const [weather, news, sport, onThisDay] = await Promise.all([
    wants('weather') ? fetchArsoCurrentWeather({ station: settings.station, timeoutMs }) : null,
    wants('news') ? fetchNewsHeadlines({ limit: settings.newsLimit, timeoutMs }) : null,
    wants('sport') ? fetchSportHeadlines({ limit: settings.sportLimit, timeoutMs }) : null,
    wants('onthisday') ? fetchOnThisDay({ date, limit: settings.onThisDayLimit, timeoutMs }) : null,
  ]);
  return { weather, news, sport, onThisDay, offline: false };
}
