# Besedila prek LRCLIB (sinhronizirana besedila, brez AI)

Sinhronizirana in navadna besedila za skladbo, ki je TRENUTNO na etru, iz
skupnostne baze [LRCLIB](https://lrclib.net) — isto izročilo, iz katerega ga
vleče SUB/WAVE (nizko-vročinski HTTP + besedilno branje LRC, nič AI), le
prirejeno našemu skladu: iskanje-first (ne `/api/get`), JSON datoteka namesto
SQLite, ruta v našem Fastifyju. Celoten klient je v `src/lyrics/`
(`lrclib.js` + `lrc.js` + `lyricsStore.js` + `lyricsService.js`), ruta pa je
priklopljena v `src/server/api.js`.

## Zakaj iskanje-first in ne `/api/get`

LRCLIB ponuja dve konici: `/api/get` (natančen zadetek na celoten podpis) in
`/api/search` (prosto ujemanje). Prirejeni načrt iz analize SUB/WAVE je
izbral ENO prošnjo: `GET /api/search` z `artist_name` + `track_name` +
`album_name` (samo če ga poznamo — prazen parameter bi FILTRIRAL) +
`duration`. Natančnost zagotavljamo SAMI (glej pravila spodaj), `/api/get`
pa ne pove ničesar, česar search ne — slab zadetek na `/api/get` bi torej
pomenil še eno prošnjo za isto skladbo.

LRCLIB je brezključaven, a zahteva, da se odjemalec poimenuje v
User-Agent — pošiljamo `radioclyde/1.0
(+https://github.com/robertpezdirc12-design/radioclyde)`.

## Konstante (etiketa, izmerjena na SUB/WAVE 2026-10-24)

| Konstanta | Vrednost | Pomen |
|---|---|---|
| `MIN_GAP_MS` | 1100 | ena obljubna veriga (throttle gate) razmika ZAČETKE prošenj; postaja z več čakajočimi iskanji pošlje največ ~1 req/s |
| `TIMEOUT_MS` | 8000 | rok za odgovor IN za branje telesa (body deadline — timer se ponovno naperi po prihodu glav) |
| `RETRY_DELAYS_MS` | [5000, 15000] | zavrnjeni odgovor (503/429) poskusimo še dvakrat, zamik pa spimo IZVEN throttle gate |
| `RETRY_AFTER_CAP_MS` | 30000 | vsak posamezen zamik = max(retryDelay, glava `Retry-After`), strop 30 s |
| `LRCLIB_DURATION_TOLERANCE_SEC` | 2 | naša lastna ±2 s vrata na trajanje rezultata |
| `RECHECK_AFTER_DAYS` | 30 | shranjen odgovor (zadetek ALI promašek) se vpraša znova po 30 dneh |
| `FAILURE_BACKOFF_MS` | 10 min | spodletelo iskanje (LRCLIB nedosegljiv) NE shrani ničesar; skladba čaka 10 minut v pomnilniku |

Odgovorni razredi odgovorov: **404/400 = dokončen promašek** (`null` —
shranjen, spet vprašan po 30 dneh); **503/429 = „vprašaj kasneje“** (dvakratni
poskus, nato izjema — nikoli dokončen promašek); **vse ostalo napak**
(timeout, transport, drugi 5xx) = izjema = „vprašaj kasneje“. Zavrnjena
prošnja v verigi NE zastrupi čakajočih za njo (gate požre zavrnitev).

## Pravila ujemanja kandidatov

- Brez trajanja > 0 sploh ni iskanja — nič drugega ne loči dveh rezov
  (radio edit / album / v živo).
- Pošlje se `leadArtist()` (razcep na feat./ft./featuring/with/x/&/vejica/
  podpičje — NIKOLI gol poševnici, AC/DC ostane cel) in `searchTitle()`
  (odstrani samo `(feat. …)`/`[feat. …]` zasluge, `[Remix]` ostane).
- Rezultat mora imeti `duration` znotraj ±2 s NAŠEGA trajanja in se ujemati po
  zloženi (`fold()`: NFKD → male črke → vse razen črk/števk ven) vsebini
  naslova IN glavnega izvajalca (ujemanje v obe smeri, podniz).
- Med zadetki velja prednostna vrsta: **sinhronizirano (`syncedLyrics`) >
  instrumental > navadno (`plainLyrics`)**. Instrumentalna plošča je pošten
  odgovor: ena „premor“ vrstica na 0 ms (panel pokaže ♪ „instrumentalni del“
  celo skladbo) — kot promašek bi bila nerazločna od „ni besedil“.

## Branje LRC (`src/lyrics/lrc.js`)

- Vrstice z več časovnimi žigi `[00:12.34][01:02.00]refren` se razcepijo na
  eno vrstico na žig (refren se ponovi na obeh mestih); izhod je stabilno
  urejen po `startMs`.
- Ulomkova številka je enota samega žiga: `.5` = desetinke (500 ms), `.50` =
  stotinke, `.500` = milisekunde.
- `[offset:+N]` premakne vse čase ZA N ms prej (`startMs − N`, spodnja meja
  0); negativen prestavi kasneje. Ena konvencija kot Navidrome.
- Vrstice z besedilom, ki je prazno ali instrumentalni označevalnik (♪ / ♫ /
  `(instrumental)` / `[au: instrumental]`), ostanejo kot PREMOR: žig ostane,
  besedilo prazno — panel jih izriše kot ♪ in do njih pride vrstica
  „trenutna“ natanko tam, kjer petje utihne.
- Besedilne oznake (`[ar:]`, `[ti:]`, …) in besedilni žigi `<mm:ss.xx>`
  (nivo besed) se vržejo ven; NE-žigovana besedilna vrstica ostane z
  `startMs: null` (panel je nikoli ne osvetli) in se zvrsti na konec.
- Telo brez enega samega žiga ni sinhronizirano — uporabi se navadno
  besedilo (`plainLyrics`), vse vrstice `startMs: null`.

## Predalnik in recheck (`src/lyrics/lyricsStore.js`)

`dataDir/lyrics-cache.json`, atomarno tmp+rename (pid-sufiks, isto disciplino
kot `pollsStore.js`). Ključ vnosa je `songId + rez`: `"Ansambel — Tema
(187s)"` — dva različna reza istega naslova sta dva vnosa, predvajanje brez
znane dolžine ključi golo pesem in ne zastrupita poznejšega predvajanja z
dolžino. Beremo na VSAKEM zadetku
`/api/lyrics/current`; `checkedAt` je epoch ms.

- Zadetek (sinhroniziran, navaden ali instrumental) in dokončen promašek so
  shranjeni; **vsak** shranjen odgovor se po 30 dneh vpraša znova. (SUB/WAVE
  je sinhronizirane zadetke hranil za vedno; mi jih preverimo znova —
  samo-zdravljenje slabega reza stane največ eno prošnjo na skladbo na mesec.)
- Spodletelo iskanje se NE shrani: pesem čaka 10-minutni zamik v pomnilniku
  (omejen na 500 pesmi), tako ponavljanje skladbe ob padlem LRCLIB ne tolče
  po njem.

## Ruta `GET /api/lyrics/current`

Zamrznjena pogodba s panelom „Besedila“ (`public/app.js`; avtoriteta je
tudi dimnik `scratch/lyrics-smoke.cjs`). Pollanje: 4 s med pending, 15 s
mirujoče, SAMO dokler je panel odprt in glasba na etru.

```json
{
  "songId": "Ansambel — Tema",
  "synced": true,
  "lines": [{ "startMs": 0, "text": "prva vrstica" },
            { "startMs": 5000, "text": "" },
            { "startMs": null, "text": "nežigovana vrstica" }],
  "source": "lrclib",
  "pending": false,
  "offsetMs": 0,
  "stationOffsetMs": 0
}
```

- `songId` je TOČNO panelov like-key (`artist — title`, pomišljaj, obrobe
  obrezane) — sprememba skladbe se prepozna na obeh straneh enako; `null` =
  glasbe ni na etru (DJ govori ali nič ni predvajano).
- `lines`: `startMs: null` za nežigovane vrstice (nikoli „trenutna“); prazno
  besedilo = premor (panel izriše ♪). Isto obliko za sinhronizirana in
  navadna besedila; `synced: true` samo če ima katera vrstica žig.
- `source`: `'lrclib'`, kadar imamo vrstice (predalnik JE lrclibovi podatki —
  pošteno ga imenujemo tako), sicer `null`.
- `pending: true` = „te pesmi še dolgujemo odgovor“: iskanje teče, čaka na
  throttle ali čaka izteka 10-minutnega zamika. NIKDI dokončen promašek —
  nedosegljiv LRCLIB ostane pending in panel mirno polla naprej, dokler se
  ne ozdravi. Pending odgovor vedno nosi prazne vrstice (zamrznjena oblika).
- `offsetMs` in `stationOffsetMs` sta aliasa postajnega zamika: vedno `0`
  (postaja ne pozna lastnega zamika; slušateljev „zamik na tej napravi“
  panel prišteje sam, na uri, ne na vrsticah).
- `503` `{ "error": "lyrics-disabled" }` kadar je `config.lyrics.enabled ===
  false` — TERMINALNO: panel preneha pollati. Manjkajoč blok pomeni
  VKLOPLJENO (iskrena privzetost: funkcija same degradira na „ni besedil“,
  ne skriva se).
- `Cache-Control: no-store` na vseh odgovorih.

Sprožilci iskanja (dvojna sprožilnika): ruta je OBVEZNI leni sprožilnik
(vsak zadetek razreši skladbo na etru, preveri predalnik/zamik, sproži
iskanje če je dolžno in ODGOVORI takoj — nikoli ne čaka na LRCLIB). Drugi,
ZGODNJI sprožilnik je `prefetchLyrics(tracks)` iz
`src/lyrics/lyricsService.js`, ki ga trije enqueue-priključki kličejo s
tvorijo, ki komaj nastopajo: končni filler pool (`generateFillerPlaylist.js`,
za atomarno zamenjavo playliste), skladbe režirane oddaje
(`director/index.js`, za `mergeTrackRatingKeys`) in odobren poslušalski
zahtevek (`requestQueue.js`, takoj za uspešnim pushom — zaigra na naslednji
meji skladbe). Vsak dolžni vnos tako dobi iskanje ŽE ob uvrstitvi v vrsto,
minute do ure pred etrom, da throttle/retry zamik pride pravočasno prek.
Oba sprožilnika delita ISTI servis (en LRCLIB throttle, ena tabela tekočih
iskanj, en 10-minutni zamik) — v produkcijski razporeditvi urnik teče v
procesu spletnega strežnika, zato se lena in zgodnja iskanja dedupirata.
`ensureLyrics(track)` ostaja primitiv ene skladbe, na katerem je prefetch
zgrajen.

Vklop zgodnjega sprožilnika: `config.lyrics.prefetch: true` (v kodi
PRIVZETO IZKLOP — a pozor: izšli `config.example.json` in namestitvena
`deploy/ubuntu/config.linux.json` ga že imata vklopljenega, zato sveža
namestitev po README navodilu („kopiraj config.example.json“) zažene
zgodnji sprožilnik; izklop je `"prefetch": false`). Obstoječe namestitve
brez vnosa ostanejo bajtno identične, lena ruta sama pokriva celo pogodbo.
Pogoj je tudi `lyrics.enabled !== false` (prva preverba v
`ensureLookup`). Pošteno opomba o enkratnih CLI procesih: `npm
run generate-filler-playlist` / `direct-show` z vklopljenim prefetchom
počakata, da tekoča iskanja pridejo do konca (prvič ~velikost poola × 1,1 s;
topol predalnik s 30-dnevno ponovno preverbo prične ~nič iskanj), urnikov
in-proces klic pa vse to odvede v ozadju.

## Zasebnost

Vsako iskanje pošlje na `lrclib.net` izvajalca, naslov (album, kadar je
znan) in trajanje skladbe, ki je na etru — javni dogodek, a vseeno odhod v
tujino. Izklop: `config.lyrics: { "enabled": false }` → 503, panel se
ugasne, omrežnih prošenj ni več. Predalnik ostane na disku (brisanje
`dataDir/lyrics-cache.json` je varno in povsem reverzibilno).

## Iskrena degradacija

| Stanje | Vedenje |
|---|---|
| predalnik prazen / skladba prvič | `pending: true`, prazne vrstice; 4 s poll pride do odgovora |
| LRCLIB nedosegljiv (timeout / 3× zavrnitev) | izjema → nič ne shranimo, 10 min zamika, odgovor OSTANE pending |
| LRCLIB 404/400 | dokončen promašek: shranjen, `pending: false`, `lines: []`, `source: null` |
| skladba brez znane dolžine | iskanja ni (ne moremo ga izpeljati); stanje = navadni promašek pod golim ključem, predvajanje z dolžino kasneje dobi svoj ključ in sveže iskanje |
| samo navadno besedilo | `synced: false`, vrstice z `startMs: null` (panel pokaže „sinhronizacija ni na voljo“) |
| instrumentalna skladba | ena premor-vrstica na 0 ms, `synced: true` |
| DJ govori / nič na etru | `songId: null`, panel pokaže svoje „zdaj na etru ni skladbe“ |
| predalnik pokvarjen | beremo kot prazen (fail-open) — vse je spet dolžno |
| `lyrics.enabled = false` | 503 terminalno, brez prošenj |
| `lyrics.prefetch` izklopljen (privzeto) | zgodnji sprožilnik mrtv; iskanja sproži samo lena ruta, obnašanje identično staremu |

## Verifikacija

```bash
# 1) obe svoji testni datoteki (brez omrežja — fetch, ura in spanje injicirani):
node --test test/lyricsLrc.test.mjs test/lyricsApi.test.mjs

# 2) ročno obliko odgovora (nadomesti dataDir v config.json z prazno mapo in
#    zapiši now_playing_track.json z glasbeno skladbo):
curl -s http://localhost:8000/api/lyrics/current | python3 -m json.tool
#    pričakovano: pending -> (4 s) -> vrstice iz pravega LRCLIB iskanja

# 3) da predalnik res piše atomarno:
ls data/ | grep lyrics-cache   # lyrics-cache.json, brez .tmp-*

# 4) LRCLIB v živo (enkrat, ročno):
curl -s 'https://lrclib.net/api/search?artist_name=Ansambel&track_name=Tema' \
  -H 'User-Agent: radioclyde/1.0 (+https://github.com/robertpezdirc12-design/radioclyde)'
```

## Reverzibilnost

1. Odstrani `registerLyricsRoute(fastify)` (+ uvoz) iz `src/server/api.js` —
   panel po 503/recenziji pade nazaj na svoje „besedila trenutno niso
   dosegljiva“ in kmalu na lastno 503-obnašanje; preostanek je mrtev modul.
2. Izbriši `src/lyrics/` in `lyrics` blok iz configa.
3. `dataDir/lyrics-cache.json` je čisti predalnik — brisanje ni škodljivo.

## Omejitve (pošteno zapisano)

- Ruta odgovarja SAMO za skladbo na živem robu (brez `?songId=` okna zadnjih
  predvajanj, kot ga ima SUB/WAVE): slušatelj za predočitvenim medpomnilnikom
  vidi besedila naslednje skladbe največ ~15 s prej, preden jegov panel
  prestavi. Zamrznjena pogodba panela je enostavnost izbrala namenoma.
- Zamik je zgolj konstanten (postaja 0 + slušateljeva naprava ±30 s);
  raztega (drug rez, drugačno trajanje) nič ne popravi — prav zato ±2 s vrata
  in rez v ključu predalnika.
- 30-dnevni recheck sinhroniziranega zadetka za enega odprtega polla pomeni
  en cikel „iščem“ (4 s), preden se stare vrstice spet postrežejo.
- Vklop/izklop `lyrics.enabled` zahteva restart procesa (kot vsak config blok).
