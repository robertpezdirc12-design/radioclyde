# Raziskava: samodejno generirane oddaje in zanimivosti med glasbo — GitHub + deterministični viri

Datum: 2026-10-24 · Sprožilec: »najdi na GitHubu najboljše skripte za generiranje
poljubnih oddaj ali kakor podcastov (oddaja o rocku, zgodovina kitar, nastopi);
ali je mogoče, da samodejno generira oddaje ali išče po spletu znamenitosti, da
med oddajo kaj reče — npr. »Queen, Freddie Mercury ... če niste vedeli: leta
tega in tega tam in tam« — in nadaljuje z glasbo.« Raziskovalni način: brez
implementacije, izhod je dokument + predlog P4.

> **STATUS — #17 in #19 IMPLEMENTIRANA (isti dan, po uporabnikovi odločitvi
> »nadaljuj po svoji profesionalni logiki, zanimivosti pa splošno o rocku,
> ne samo Freddie Mercury«):**
>
> - **#17 »Zanimivosti« je NARJENA GENERALIZIRANO** — točno po sklepu
>   uporabnika: dejstvo se pove o KATERIKOLI izvajalcu (Queen je samo primer;
>   MusicBrainz → sl.wikipedia rezerva, s zaščitami pred napačno entiteto),
>   poleg njega pa lokalni korpus **splošnih** rock zanimivosti (kitare,
>   albumi, nastopi, radio — tudi slovenski: Pankrti, Buldožer).
> - **#19 »Na današnji dan v glasbi«** je narjena kot rubrika `glasba`
>   (isti Wikidata cev, filter poklica P106/P279* na glasbenike).
> - **Odločitev okusa (§5.3): zanimivost zazveni PRED skladbo** kot običajen
>   govorni rez (deterministično, enako ostalim rubrikam); postelja čez
>   začetek skladbe ostane odprta varianta prihodnosti.
> - Implementacija: `src/auto/trivia.js`, `src/auto/rockFacts.js`,
>   sloti `triviaArtist`/`triviaGeneral`/`obzorjeGlasba`, reference v
>   [auto-radio.md](auto-radio.md) §Rubrike. npm test 301/301 (83 suitov,
>   0 fail, 0 skip pod PIPER_LIVE=1).
> - **#18 (generator tematskih oddaj) je prav tako IMPLEMENTIRAN** (isti dan,
>   po uporabnikovem »odlično, nadaljuj« ob posredovanem GitHub žetonu):
>   katalog kuriranih tematskih oddaj (`src/auto/showCatalog.js`; ob širitvi
>   P4 #21 jih je štirinajst: nove so »Blues korenine«, »Trdi rock in metal«,
>   »Progresivni rock« in »Ženske v rocku«) +
>   tedenski special slot v station.json (`"special": { "themes": [...],
>   "personas": [...] }`), rotacija po ISO tednu, brifi se izrisujejo v
>   `show-descriptions/themed/<tema>.md`, CLI `npm run themed-shows`.
>   npm test 323/323 (89 suitov, 0 fail, 0 skip pod PIPER_LIVE=1).
>
> - **#22 (rubrika "Kviz") je IMPLEMENTIRAN** (po uporabnikovem »odlično,
>   nadaljuj«): resnična kviz vprašanja (korpus `src/auto/quizFacts.js`, 25
>   kuriranih vprašanj z enim preverljivim odgovorom) na ŽE OBSTOJEČEM kviz
>   položaju (`quizIntro`/`quizReveal` ob sredinski skladbi briefa s `quiz`
>   segmentom) — stari sloti in letno ugibanje ostanejo rezerva, voice
>   plast se ni spremenila. Ključna beseda `kviz`/`quiz` v `Rubrike:` vrstici,
>   nastavitev `rubrics.quizCount` (privzeto 1). Edina rubrika, ki v
>   `--offline` načinu deluje CELA (korpus brez omrežja). Reference v
>   [auto-radio.md](auto-radio.md) §Kviz.

## 1. Kaj stationa že zmore (zemljevid obstoječega stanja)

Dve od treh zahtevanih zmožnosti sta že v repotu — pomembno je vedeti, kje
točno, da predlog ne ponuja obstoječega:

| Zahteva | AI način (klasika) | Auto način (`autoRadio`) | Vrzeli |
|---|---|---|---|
| Besedilo DJ-ja z resničnimi dejstvi o izvajalcu | **že deluje**: vsaka DJ vrstica se piše proti Wikipedia dejstvom o skladbi/izvajalcu (src/producer), z zaključnim urejanjem skozi celoten skript | fiksne slovenske predloge iz metapodatkov knjižnice — **brez** zunanjih dejstev | auto način ne zna povedati ničesar o Queen, če tega ni v tagih |
| »Na današnji dan« / servisi v živo | LLM sestavi žive vrstice | **že deluje**: ARSO vreme, RTV novice/šport, Wikidata rojstva/smrti (obzorje) — vse deterministično (src/auto/feeds.js) | Wikidata poizvedba ni omejena na glasbenike; ni vezave na program (kaj sedaj igra) |
| Poljubne tematske oddaje (rock, kitare, nastopi) | človek napiše brief → pipeline ga izvede | človek napiše brief (`show-descriptions/*.md`) → pravila izvedejo | **brief sam mora napisati človek**; noben generator briefov ne obstaja |
| Vstavljanje govora med glasbo | že deluje (rezi iz `.script.md`) | že deluje (segmenti + postelje #12/#13) | vsebina segmentov je omejena na rubrike + predloge |

Ključna spoznanja: **mehanika** (skript → režiser → govor → playlist → radio.liq,
vključno s posteljami čez glasbo) je popolna; manjkata **dva vira vsebine**:
(1) deterministična zanimivost o izvajalcu, ki sedaj igra, in (2) generator
tematskih briefov. Oba sta čisto deterministična projekta — noben ne potrebuje
LLM-ja.

## 2. GitHub raziskava — kaj je tam in kaj je vredno pozornosti

Raziskani projekti, ki niso že obdelani v
[ready-made-scripts-analysis.md](ready-made-scripts-analysis.md) (SUB/WAVE,
WRIT-FM, radio-dj, AzuraCast, LibreTime, autocue so tam):

| Projekt | Kaj je | Licenca | Kaj (ne) vzeti |
|---|---|---|---|
| **savonet/ai-radio** + blog »Video Canvas and AI« (2024-02-10) | uradni primer Liquidsoap ekipe: AI DJ vsake 4 skladbe; `playlist(prefetch=2, check_next=...)` da VEDO, kaj igra naslednje, OpenAI chat napiše besedilo (stil, leto, instrumenti, kulturni kontekst, anekdote), OpenAI speech ga izgovori, `request.create("annotate:...tmp:...")` vrine govor v vrsto | ni izrecna licenca (primer kode) | vzeti **idejo `check_next`/prefetch** — vemo, katera skladba je naslednja, zato lahko zanimivost napišemo O NJO že ob produkcijskem času (deterministično, brez oblaka). Celotnega LLM-vzorca ne vzamemo: zahteva OpenAI ključ in mrežo ob oddaji |
| **perminder-klair/subwave** (~1.4k ★, MIT) | agentic AI DJ (Ollama lokalno ali oblak), izbira skladb v pogovorni zanki, lasten mikser — že globoko analiziran (transitions #11) | MIT | nič novega za brez-AI arhitekturo; potrditev, da je »DJ, ki zna povedati anekdoto« glavna vrednost AI DJ-jev — jo bomo dosegli deterministično |
| **souzatharsis/podcastfy** (~8k ★) | odprti NotebookLM naslednik: večmodalen vnos → LLM skript → večjezični TTS → zložen zvok | Apache-2.0 | struktura epizode (intro → bloki → outro) je prenašalna, toda jedro je LLM — za auto način zavržemo; koristno kot vzor za #18 shemo blokov |
| **lfnovo/podcast-creator** | Python knjižnica: tema → skript (LLM) → segmenti → TTS (razni ponudniki) | MIT | ista klasa kot podcastfy; potrjuje industrijski vzorec *skript → segmenti → TTS* — ki ga naš režiser že ima |
| GitHub topic `ai-podcast` / `ai-radio` | samogostiteljski NotebookLM nasledniki (RSS, lokalni modeli), personalizirani radijski prototipi (novice + Spotify okus + TTS host) | razne | trend se ujema z našo arhitekturo (vse pred-generirano pred oddajo); nič konkretnega za izposojo |
| **Music Assistant — AI Radio DJ persone** (razprava #5937, jul 2026) | predlog skupnostne zbirke DJ person (»80s Disco DJ«, »Pirate«) kot JSON feed, ki prednastavi kontrole | n/a (razprava) | ideja **persone kot paket** (glas + vzorci + rubrike v enem JSON-u) — naša personas struktura to že skoraj je; vredno omeniti pri #18 |
| **teticio/Deej-AI** (~0.5k ★) | globoko učenje *posluša* glasbo in gradi podobnostne plejliste | MIT | protouravnoteženje: naša izbira je pravilna + znana metapodatka; pytorch odvisnost za en signal je predraga — zavržemo (dokumentirano tudi v ready-made analizi) |
| **WB2024/Navidrome-SmartPlaylist-Generator** | ~300 pripravljenih pametnih plejlist-predlog (desetletja, razpoloženja, tempo, redkost) kot `.nsp` JSON pravila | MIT | **katalog vzorcev** — zunanja taksonomija za smartBlocks (#14) in za katalog tematskih oddaj #18 (»This is ...«, deep cuts, kronologija) |
| **lhkastenson/trivia-mcp-server** in drugi trivia strežniki | Wikipedia API: povzetki, On This Day, rojstni dnevi + DuckDuckGo iskanje | MIT | potrjuje naš izbor virov (Wikipedia/Wikidata); MCP ovojnica je za nas odveč — kličemo naravnost |
| RadioGPT (Futuri) | komercialen: Topic Pulse (trendi) + GPT-4 + govor, celotne postaje | zaprt | koncept *trending topics* bi šel deterministično skozi RTV RSS, ki ga že imamo (novice) |

**Skupni imenovalec industrije**: vsi resni projektu sledijo vzorcu
*izberi → razišči → napiši → izgovori → vstavi*, le raziskovalni korak delajo
z LLM-jem. Naša prednost: za slovenščino in znan ostali kontekst zadostujeta
Wikipedia sl + Wikidata + MusicBrainz — **strukturirani podatki, ne besedila**.

## 3. Deterministični viri zanimivosti — živo preverjeno (2026-10-24)

Vsi trije delujejo brez ključev, z uporabniškim agentom, iz tege okolja:

### 3.1 Slovenska Wikipedia — REST povzetek strani

`GET https://sl.wikipedia.org/api/rest_v1/page/summary/Freddie_Mercury` →

> Freddie Mercury, s pravim imenom Farrokh Bulsara, je bil britanski glasbenik,
> pevec in frontman skupine Queen, \* 5. september 1946, Stone Town,
> Zanzibarski sultanat, † 24. november 1991, London, Združeno kraljestvo.

To je dobesedno zahtevana poved »Queen, Freddie Mercury ... leta tega tam in
tam« — v slovenščini, brez modela. Vzorec prvega odstavka je skladenjsko
stabilen (`, * datum, kraj, † ...`), pa vendar je za predloge varneje razčleniti
**strukturirane** vire (3.2, 3.3) in Wikipedia extract uporabiti kot rezervo
(le celotna poved, nikoli razčlenjena).

### 3.2 MusicBrainz ws/2 — kronologija in žanri

`GET https://musicbrainz.org/ws/2/artist?query=artist:Queen&fmt=json&limit=1`
→ `name: Queen, country: GB, life-span.begin: 1970-06-27, tags: rock, pop,
progressive rock, 70s`. Omejitev **1 zahteva/s na IP** (humano: cache + ena
poizvedba na izvajalca na proizvodnjo) in **obvezen User-Agent**. MBID prek
relacije `wikipedia`/`wikidata` zvari na 3.1/3.3 brez ugibanja imena strani.

### 3.3 Wikidata SPARQL — glasbeniki na današnji dan (razširitev obstoječe rubrike)

Poizvedba v feeds.js (obzorje) že prinaša rojstva/smrti s slovenskimi oznakami;
dodan filter `wdt:P106` (poklic) ∈ {pevec, glasbenik, kitarist, skladatelj, ...}
da rubriko **»Na današnji dan v glasbi«** brez vsakega novega vira — ista cev,
isti cache, ista skip-not-fail pogodba.

### 3.4 Kje se vse to veže v obstoječo arhitekturo

- rubrični vnosi v briefih: `RUBRIC_KEYWORDS` v src/auto/briefQuery.js
  (`Rubrike: vreme, šport, obzorje, zanimivosti`) — razširitev tabele za en
  vnos,
- pridobivanje podatkov: src/auto/feeds.js vzorec (timeout, TTL cache,
  null-on-failure) — nov `fetchArtistTrivia(artist)`,
- rezi: režiser že ve, katere skladbe so v vrsti, zato zanimivost ob produkciji
  zapišemo **pred njeno skladbo** (ali prek postelje #12 takoj za začetkom
  skladbe) — nič novega v radio.liq,
- želja savonet prijateljev (`check_next`) nas sploh ne prizadene: naš plejlist
  je znan še pred oddajo, ker celotno oddajo naprej pripravimo.

## 4. Predlog P4 (za odločitev — nič od tega ni še narejeno)

| # | Predlog | Obseg | Vrednost |
|---|---|---|---|
| **16** | Preimenovanje prikaznega imena v **Radio Markec** (UI, konfiguracija, manifest, README, vzorčni podatki; inženirska imena radioclyde — paket, servisi, repo, android applicationId — ostanejo za zdaj nespremenjena) | naredil ta commit | identiteta postaje |
| **17** | Rubrika **»Zanimivosti«** za auto način: `Rubrike: zanimivosti` → za izvajalce izbrane vrste ena deterministična poved (MusicBrainz leto/nastanek/država + rezerva Wikipedia sl extract, s zaščitami pred napačno entiteto: MB ime mora ujemati poizvedbo, wiki stran ne sme biti razločevalna in mora ujemati naslov), PLUS lokalni korpus splošnih rock zanimivosti (`src/auto/rockFacts.js`, 40 kuriranih fakty, deluje brez omrežja); vstavljanje pred uvod vsake tretje skladbe, izvajalčev fakt ima prednost; cache na izvajalca (24 h), MusicBrainz 1 zahteva/s; skip-not-fail | **NAREJENO** | točno zahtevani »Queen/Freddie Mercury« posnetek — in katerikoli drug izvajalec, plus splošne rock zanimivosti, brez LLM |
| **18** | **Generator tematskih oddaj**: katalog predlog oddaj (»Zgodovina rocka«, »Zgodovina kitare«, »Veliki nastopi«, po Navidrome taksonomiji: desetletja/žanri/razpoloženja) → izpisuje prave `show-descriptions/*.md` brife (pravila + `Rubrike: zanimivosti`) → obstoječi pipeline jih izvede; tedenski »special« slot v station.json | **NAREJENO** (`src/auto/showCatalog.js`, ISO-tedenska rotacija, CLI `npm run themed-shows`, [auto-radio.md §Tematske oddaje](auto-radio.md)) | poljubne oddaje brez pisanja briefov ročno |
| **19** | **»Na današnji dan v glasbi«**: filter poklica (P106/P279* na Q639669) na obstoječi Wikidata poizvedbi obzorja, nova rubrika `glasba`, slot `obzorjeGlasba` | **NAREJENO** | glasbena rubrika skoraj zastonj |
| 20 | (odsvetovano za zdaj) agentic DJ s lokalnim LLM po vzoru SUB/WAVE / savonet ai-radio v živo | velik | proti arhitekturi brez AI; GPU strošek; vseeno bi govor zasedal rezi, ki jih že imamo |

Neodvisni viri se lahko kombinirajo: #17 je vsebina, #18 je oblika (razporeja
bloke in pokliče #17), #19 je poceni dodatek k obstoječi rubriki.

## 5. Kaj bi potrebovalo odločitev uporabnika

1. Ali gre #16 do konca (tudi package.json, systemd enote, android
   applicationId, GitHub/GitLab ime repota) ali ostane pri prikaznem imenu?
2. Kateri predlogi iz §4 dobijo zeleno luč in v kakšnem vrstnem redu?
3. Odprto vprašanje okusa: sme zanimivost zazveneti **pred** skladbo (trd rez,
   kot govorni rezi zdaj) ali **čez** začetek skladbe (postelja #12/#13,
   glasba se utiša) — ali izmenično po personi?
