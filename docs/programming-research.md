# Raziskava: kako programirajo dan najboljše postaje — workflowi, odaje čez dan, napovedi

*Datum: 2026-10-26 · Radio Markec main @ `0a13a44` · Task 19 (raziskovalna val: analiza spleta → primerjava z našim → predlogi; BREZ sprememb produkcijske kode)*

## 0. Metodologija

Vsi tuji viri so bili pobrani z živega spleta 2026-10-26 in citirani po izluščenem besedilu
(najbližja odprtokodna sorodnika našega sistema — AzuraCast, LibreTime — ter enciklopedična
in strokovna gradiva o radijski praksi):

| Vir | URL | Uporabljeno za |
|---|---|---|
| Wikipedia: Dayparting | <https://en.wikipedia.org/wiki/Dayparting> | kanonski deli dneva, drive time, midday praksa |
| Wikipedia: Voice tracking | <https://en.wikipedia.org/wiki/Voice_tracking> | govorni vtiči, "hitting the post", legal ID ob polni uri |
| Wikipedia: Radio imaging | <https://en.wikipedia.org/wiki/Radio_imaging> | inventar imaging elementov (sweeperji, promosi, stingerji …) |
| AzuraCast: Playlists | <https://www.azuracast.com/docs/user-guide/playlists/> | tipi rotacij, sistem prednosti, časovni bloki |
| AzuraCast: Now Playing Data APIs | <https://www.azuracast.com/docs/developers/now-playing-data/> | sedaj/naslednje metapodatki, SSE/Websocket |
| LibreTime: Scheduling shows | <https://libretime.org/docs/user-manual/scheduling-shows/> | show workflow, ponovitve, autoloading, intro/outro |
| LibreTime: Playlists and smart blocks | <https://libretime.org/docs/user-manual/playlists/> | pametni bloki, vtiči med glasbo |
| LibreTime: Show calendar | <https://libretime.org/docs/user-manual/calendar/> | koledar, pod-/nad-urna opozorila |
| radio.co: Elements of a Radio Station | <https://www.radio.co/blog/elements-of-a-radio-station-everything-you-need-to-build-your-own-station-from-scratch> | ekosistem postaje, oznake (tags), watershed |
| radio.co: Radio Automation Software Guide | <https://www.radio.co/blog/radio-automation-software-complete-guide> | avtomatizacija, rezervna plejlista |

Naša stran: popolna preslikava zmožnosti iz raziskave 19-a (samo-branje, vnos v worklog),
nosilne trditve pa je orkestrator spotno preveril sam (`liquidsoap/radio.liq:104-109`,
`src/director/liveSegments.js:24-30`, `src/scheduler/scheduleUtil.js:61-118`).

---

## 1. WORKFLOWI NAJBOLJŠIH

### 1.1 Profesionalna (komercialna) postaja

Pri profesionalni postaji se glasba **ne** izbira ročno ob oddaji. Delovni tok je
tri-plasten in vsaka plast ima svojega odgovornega:

1. **Knjižnica + pravila rotacije** — glasbeni urednik vnaprej določi, kateri bazeni
   skladb obstajajo (močna rotacija A, srednja B, globoka C, novosti) in pravila
   ločevanja (isti izvajalec ne prej kot po X urah ipd.).
2. **Formatna ura in log** — vsaka ura ima PREDLOGO ("format clock") s fiksnimi mesti:
   identifikacija postaje ob `:00` (Wikipedia, Voice tracking: *"DJs have to play the
   station's legally required identification near the top of the hour"*), rubrike na
   fiksnih minutah, promo sloti, bloki glasbe. Razporejevalnik (v praksi RCS Selector,
   MusicMaster …) vsako uro zloži konkreten "log" po tej predlogi.
3. **Govorni vtiči (voice tracking)** — DJ vnaprej posname kratke povezave, ki se
   vstavijo ob predvidenih mestih; govor teče po instrumentalnem uvodu skladbe
   (*"hitting the post"*, Wikipedia, Voice tracking), ne čez vokale.

Skupni imenovalec: **stroga ločitev "kaj se igra" (knjižnica) od "kdaj" (ura/kvadrant)
od "kdo govori" (vtiči)**. Wikipedia (Radio imaging) to povzame takole: *"[sweepers,
promosi in jingles] create seamless transitions between programming units"* — elementi
med programskimi enotami so samostojna, načrtno razporejena plast, ne naključje.

### 1.2 Odprtokodni referenčni sistemi (najbližji sorodniki)

**LibreTime** — osnovni delovni tok je povzet v njihovi dokumentaciji kot
*»Upload media → create a show on the Calendar → Schedule Tracks«*: knjižnica,
koledar, ročni drag-and-drop urnik oddaje. Oddaja ima `Repeats?` (tedensko do
mesečno, več dni na teden, možen konec), `Linked?` (ista vsebina za vse ponovitve),
**Autoloading Playlist** (sistem nafila oddajo iz plejliste **1 uro pred eterom**,
lahko ponavlja do polnosti), **Select Intro/Outro Playlist** (nadomesti *globalno*
intro/outro plejlisto iz nastavitev — imaging ob mejah oddaj!), `Instance Description`
(opis posamezne epizode ponavljajoče se oddaje) in dodeljenega DJ-ja. Koledar opozori,
če je oddaja **pod-urna** (dead air na koncu) ali **nad-urna** (zadnje skladbe se ne
zaigrajo). Pametni bloki (smart blocks) so naš pogodbeni sorodnik: kriteriji po
metapodatkih, limiti (ure/minute/kosi), statični ali dinamični; *"Jingles and voice
tracks can be added before, after or between music items"*.

**AzuraCast** — programiranje dneva je popolnoma plejlistno. Tipi plejlist:
`General Rotation` (ves dan), `Once per X songs`, `Once per X minutes`,
`Once per hour` (celo OB DOLOČENI MINUTI!) in `Once per day` (ob določeni uri) —
vsak tip se lahko razporedi **v časovne bloke dneva in v datumski razpon**. Nad tem
je eksplicitni sistem prednosti: zahteve poslušalcev so vedno na vrhu, nato
once-per-hour načrtovane (7) … general rotation (0); višja prednost vedno zmaga, kar
omogoča "stavljanje" plejlist v isti slot. Za napredne uporabnike: Advanced playlist —
surova Liquidsoap konfiguracija, npr. `rotate(weights=[1,1,5], [jingles, reklame, glasba])`.

**radio.co** — koledar z vlečenjem; ob razporejenem živem dogodku izbereš **rezervno
plejlisto, ki zavzame eter, če DJ ne poveže**; knjižnica se organizira z oznakami
*genre, mood, era*; vodnik izrecno pove, da razporejanje poskrbi, da je *»something
family-friendly at breakfast and no swearing before the watershed«* — to je
**kvadrantna primernost vsebine** kot lastna skrb sistema.

### 1.3 Kaj to pomeni za Radio Markec

Naš ekvivalent "workflowa" je **celovod** (`show-descriptions/*.md` povzetek →
producent: izbira skladb + raziskava + poteze → režiser: TTS, stikanje, `playlist.m3u`
→ eter), s predogrevanjem v izdihu čez downtime in preverjanjem dejanskih trajanj s
ffprobe (updateNowPlaying.js). Primerjava:

- **BOLJŠE od LibreTime**: njihov osnovni tok čaka ročni "Schedule Tracks"; naš
  producent sestavi celotno oddajo iz povzetka sam (AI ali deterministično).
- **BOLJŠE od AzuraCast**: plejlistni pristop nima pojma o "voditelju"; naša cevovod
  proizvede DJ govor, kvize, vreme.
- **VRZEL ni v avtomatizaciji, temveč v programski plasti NAD njo**: AzuraCastovo
  "once per hour ob minuti", LibreTimeovi intro/outro ob mejah oddaj in profesionalna
  formatna ura so vsi vzorci, ki pri nas obstajajo le delno (ID ob `:00`) ali nič
  (promo sloti, vreme na fiksni minuti, napoved naslednje oddaje).

---

## 2. ODAJE ČEZ DAN (DAYPARTING)

### 2.1 Kanonski kvadranti (Wikipedia: Dayparting, po Nielsen Audio)

| Kvadrant | US (Nielsen) | Značilnost prakse |
|---|---|---|
| Jutranji drive | 06:00–10:00 | najbolj poslušan (avto); lokalno, živo |
| Midday | 10:00–15:00 | ujet poslušalec; *"9 to 5 No Repeat Workdays"* — NE ponavljaj skladb |
| Popoldanski drive | 15:00–19:00 | drugi vrh; lokalno |
| Večer | 19:00–24:00 | tematsko, specializirano |
| Noč | 00:00–06:00 | avtomatizirano, vtiči brez človeka |

Vikend ima svojo logiko (sobota zvečer pogosto živo; nedelja jutro svoj žanr).
radio.co dodaja: primernost vsebine po kvadrantu (watershed). LibreTime/AzuraCast
kvadrante izrazita s časovnimi bloki plejlist / autoloading ob mejah oddaj.

### 2.2 Naša realnost (preslikava 19-a, s citati)

- **Urnik je TEDENSKA predloga**: `station.json` → `schedule: { ponedeljek: [...] }`
  (`scheduleUtil.js:61-73`); occurrence = `id`/`startTime`/`durationMinutes`/
  `description`; downtime je ENO okno za vse dni (`scheduleUtil.js:102-118`).
  Prekrivanja rešujejo zamenjava/repack/zapiranje vrzeli (stationWriter.js) —
  mehanično zrelo. **Ni datumske odveze** (prazniki, enkratni dogodki) in **ni
  ponovitev** (replay/rebroadcast).
- **Filler ima kolo kvadrantov, a neslišno**: `config.filler.clockwheel` podpira
  `dayparts: [{from,to,steps}]` (clockwheel.js; konfiguriran primer že v
  config.example.json), vendar `radio.liq:109` odpošlje `mode="randomize"`, ki
  vrstni red kolesa PONOVNO PREMEŠA pred predvajanjem — v kodi je dokumentirana
  enobesedna sprememba (`radio.liq:104`, `mode="normal"`). Dodatna meja: kolo se
  izbere ob GENERACIJI (vsakih 6 h), ne glede na uro PREDVAJANJA.
- **autoRadio.timeOfDayBlocks** (samo samodejna pot): jutro/dan/večer/noč izbirata
  različico pozdravov (templates.js); `preferredGenres` po bloku je PRIPRAVLJEN,
  a NEUPORABLJEN (`auto/rules.js:110-116`, priznano v docs/auto-radio.md:999-1003).
- **AI pot je zavestno brez zavesti o uri dneva**: `TIME_OF_DAY_INSTRUCTION`
  (src/llm/prompts.js) izrecno prepoveduje "good evening/tonight" — odločitev proti
  halucinacijam časa ob predprodukciji.
- sample-data kvadrante modelira ROČNO z oddajami (`jutro-auto.md`, `noc-auto.md` …).

### 2.3 Vrzel v enem stavku

Imamo stroj (tedenski urnik + rotacijska pravila + kolo kvadrantov za polnilo), a
**stroj ne ve, da je jutro jutro** — razen v pozdravih samodejnega načina in v
(trenutno neslišnem) kolesu polnila. AzuraCastovo "plejlista 06–10 z once-per-hour
ID-jem" pri nas ni izrazljivo, ker razporedba ne pozna pojma kvadranta.

---

## 3. NAPOVEDI

### 3.1 Kaj so "napovedi" v praksi — tri plasti

1. **Besedilno/vizualno ("Sedaj ↔ Naslednje")**: RDS Radiotext / DAB DLS pri
   oddajnikih; pri spletnih postajah icy-metapodatki toka + predvajalnik/aplikacija.
   AzuraCast to obravnava kot prvorazrednega državljana: celoten "Now Playing" paket
   (skladba, poslušalci, živi DJ, zgodovina ~5 skladb, `elapsed`/`remaining`) z
   visokozmogljivo dostavo prek Websocket/SSE (Centrifugo), ker služi 1000+
   poslušalcev (now-playing-data.md).
2. **Govorno**: DJ napove, kaj sledi — vtič *"coming up next"*, tease *"kasneje v
   oddaji"*, legal ID ob polni uri (Wikipedia, Voice tracking).
3. **Imaging/promo**: sweeperji, stingerji, **promosi za prihajajoče oddaje** —
   Wikipedia (Radio imaging) jih našteva med elementi, ki *"create seamless
   transitions between programming units"*. AzuraCast: promo v rotaciji (once per X
   songs / once per hour ob minuti); LibreTime: **intro/outro plejlisti ob mejah
   oddaj** (globalne + per-oddaja) — to je dobesedno "napoved pred/za oddajo" kot
   sistem.

### 3.2 Naš inventar (19-a)

**Imamo:**

- ID postaje ob polni uri — overlay `{0m0s}` točno po cookbook receptu
  (`radio.liq:143-158`); celo BOLJŠE od preproste predvajalne vrste, ker se zmeša
  NAD program.
- Stingerje (`delay(1800.)`, na mejah skladb) in **postelje** s sidechain duckerjem
  (`beds.push` po telnetu) — potisk postelje je bil ob raziskavi izključno ROČNO
  operatersko dejanje; od valu 23 (Paket D1) ga poganja `formatClock.js` sam
  (docs/imaging-layer.md:28).
- DJ napoved **naslednje skladbe** (AI: `moves.js` generateIntroLine "Napiši kratko
  predstavitev prihajajoče skladbe"; auto: templates.js intro predloge) in tease —
  a tease SAMO v samodejnem načinu (scriptBuilder.js; AI boundaryWalk tease nima).
- Push obvestilo 2 min pred začetkom oddaje (`dispatch.js:49-59`).
- Na spletu: seznam "Naprej po urniku" + tedenska mreža z žetoni ZDAJ/NASLEDNJI
  (app.js) — a HERO kaže samo trenutno skladbo/DJ, ne naslednje oddaje.

**Manjka:**

- **Govorna napoved NASLEDNJE ODDAJE ob zaključku** — zaključna poteza je čisti
  poslovilni govor; poslušalcu ne pove, kaj sledi. (Pro standard; LibreTime intro/outro.)
- **Promo plast** — promosi kot vsebinska plast ne obstajajo (stingerji so edini
  vmesni element; `bedQueue.js` omenja promo le kot možno vsebino postelje).
- **Metapodatki toka**: `output.icecast` brez `name/description/genre`
  (`radio.liq:649-653`); RDS/icy "Sedaj: X | Naslednje: Y" ne obstaja.
- **Enotska napaka v AI živih segmentih**: `liveSegments.js:29` pošilja LLM
  vrednosti z oznako `°F`/`mph` — Open-Meteo privzeto vrača °C, torej je oznaka
  napačna ŽE FAKTIČNO, slovenska postaja pa želi metrične enote v vsakem primeru.
- AI pot nima tease in nima zavesti o uri (zgoraj).

### 3.3 Vrzel v enem stavku

**Napovedujemo skladbe, ne pa oddaje** — in vse napovedi so "vsak zase", brez
programske plasti, ki bi jih razporedila po dnevu (promo pred začetkom oddaje, vreme
na fiksni minuti ure, "naslednja oddaja" ob zaključku).

---

## 4. PRIMERJALNA TABELA

| Zmožnost | Industrija (vir) | Radio Markec (citat) | Sodba |
|---|---|---|---|
| Tedenski urnik + urejanje z vlečenjem | LibreTime: koledar drag&drop | studioScheduleApi + vlečenje s 30-min zamikom | **PAR** |
| Pod-/nad-urna opozorila | LibreTime: barve na koledarju | prewarm + ffprobe dejanskih trajanj | **PAR** (strožje) |
| Rezerva ob odsotnosti vsebine | radio.co: backup plejlista | filler kot vedno-rezerva + emergency plast | **PAR** (druga filozofija) |
| ID ob polni uri | Wikipedia VT: legal ID | `radio.liq` `{0m0s}` overlay | **PAR** (overlay > vrsta) |
| Stingerji/sweeperji | Wikipedia: imaging | `delay(1800.)` | **PAR** |
| Govorna napoved naslednje skladbe | pro: VT "coming up next" | moves.js + templates.js intro | **PAR** |
| Deli dneva v glasbeni rotaciji | AzuraCast: plejliste na časovne bloke | clockwheel dayparts — a `mode="randomize"` uniči vrstni red (`radio.liq:109`) | **VRZELA (1 beseda)** |
| Kvadrantna glasba v samodejnem načinu | — (ekstra) | timeOfDayBlocks + neuporabljeni `preferredGenres` | **VRZEL (pripravljeno)** |
| No-repeat sredina dneva | Wikipedia: "9 to 5 No Repeat" | recentlyPlayed (30 d) + 24 h okno fillera | **PAR** (globlje) |
| Govorna napoved naslednje ODDAJE | pro standard; LibreTime outro | NE OBSTOJA (zaključek = poslovilni) | **VRZEL** |
| Promosi za prihajajoče oddaje | Wikipedia imaging; AzuraCast rotacija | NE OBSTOJA (stingerji edini) | **VRZEL** |
| "Sedaj/Naslednje" na spletu | AzuraCast NP API | /api/now-playing + upcoming + mreža; hero BREZ naslednje | **DELNO** |
| "Sedaj/Naslednje" v metapodatkih toka | icy-name/description; RDS | `output.icecast` brez imen (`radio.liq:649-653`) | **VRZEL (majhna)** |
| Žive posodobitve poslušalcem (WS/SSE) | AzuraCast: Centrifugo | polling na javni strani | **OK za obseg** (zavrnjeno: §5) |
| Vreme/čas govorno | pro rubrike | liveSegments — a °F/mph napaka | **PAR po popravku** |
| Enkratne/datumske oddaje (prazniki) | AzuraCast: date ranges | NE OBSTOJA (samo tedenska predloga) | **VRZEL** |
| Ponovitve/rebroadcast | LibreTime: Repeats/Linked; pro encores | NE OBSTOJA (djAudio predpomnilik pa OBSTOJA po epizodi!) | **VRZEL (dober temelj)** |
| Analitika → program | radio.co: peak times | listener-analytics brez zanke v rotacijo | **DELNO** |

---

## 5. PREDLOGI — roadmap

Vsi predlogi so skladni z našo doktrino: 0 novih odvisnosti, atomske operacije
(tmp+rename), poštena degradacija ("izpusti plast, ne program"), dokumentirani
literali v radio.liq. Razvrščeni po vrednost/strošek v štiri pakete.

### Paket A — hitre zmage (en manjši val)

> **DOSTAVLJENO v valu 20** (A1 slišno kolo — `radio.liq` `mode="normal"`; A2 °C/km/h; A3 hero "Naprej:" vrstica; A4 `preferredGenres` aktiviran — docs/auto-radio.md, razdelek o pravilih).

| # | Predlog | Kje | Ocena |
|---|---|---|---|
| A1 | **Slišno kolo kvadrantov**: `radio.liq:109` `mode="randomize"` → `"normal"` (dokumentirana enobesedna sprememba, stalno opozorilo v clockwheel.js). Veljaven pomislek: brez kolesa se enak vrstni red ponovi v zanki do naslednje regeneracije — a bazen 200 skladb ≈ 13 h glasbe, regeneracija pa vsakih 6 h, zato se zanka pred spremembo redko dokonča; raznolikost prihaja iz regeneracije (Node premeša vsakič). V dokumentaciji povedati obe vedenji. | 1 beseda + testi/dokumenti | zelo nizek strošek, takojšen slišni učinek |
| A2 | **Metrične enote v AI živih segmentih**: `liveSegments.js:29` — °C/km/h (oznaka °F nad Open-Meteo °C vrednostmi je napačna že dejansko). | 1 vrstica + test | nizek |
| A3 | **Hero "naslednja oddaja ob HH:MM"** na poslušalski strani: podatki že tečejo (scheduleGrid `nextShow {hasGap}`; app.js že riše "Naprej po urniku"); čist UI dodatek v heru. | app.js/index.html | nizek |
| A4 | **Aktivacija `preferredGenres`** v autoRadio timeOfDayBlocks (rules.js:110-116 pripravljeno "mehko usmerjanje"; genre preference po kvadrantu). | rules/produce + testi | nizek–srednji |

### Paket B — napovedi (jedro tega vprašanja; en val)

> **DOSTAVLJENO v valu 21** (B1 zaključna govorna napoved naslednje oddaje; B2 promo plast; B3 icy identiteta toka — docs/auto-radio.md "Paket B1" in docs/imaging-layer.md §4).

| # | Predlog | zasnova |
|---|---|---|
| B1 | **Zaključna napoved naslednje oddaje**: producentu/režiserju ob zaključni potezi podamo kontekst `nextOccurrence` za dan oddaje (scheduleUtil ga že računa za updateNowPlaying). AI: razširitev poziva zaključka ("napovej, kaj sledi po tej oddaji: ime, ura, voditelj — enostavno, brez oglaševalskega tona"); auto: predloga "Ob HH:MM pa sledi <oddaja> (voditelj: X). Ostani z nami!" **Poštena degradacija**: brez naslednje oddaje → čisti poslovilni govor kot danes. **Honest caveat za dokumentacijo**: produkcija teče pred eterom (prewarm) — kasnejša sprememba urnika pusti napoved odveč; to je enaka življenjska doba kot vsa predprodukcija (DJ govor ne ve niti za skip). |
| B2 | **Promo plast** (4. imaging plast): `imaging/promos.m3u` + plast v radio.liq po vzorcu stingerjev (`delay(N.)`, meje skladb), klipi v `dataDir/imaging/promos/`. Vsebina: promosi za prihajajoče oddaje, TTS-produkcija prek obstoječe Edge poti (enak postopek kot ID/stingerji, docs/imaging-layer.md §4). Prazna mapa = plast ne obstaja (enaka degradacijska lestvica). AzuraCastov ekvivalent: once-per-X rotacija; naša prednost: promo vsebino lahko BEREMO iz urnika. |
| B3 | **Oprema metapodatkov toka**: `output.icecast` dobi `name`/`description`/`genre` (danes popolnoma odsotni, `radio.liq:649-653`); opcijsko posodobitev mount-description z "Sedaj: X" ob vsaki menjavi (preveriti podporo Icecasta pri implementaciji; če ni čista, samo statični imeni). Icy "Naslednje: Y" je lep plus, ne pogoj. |

### Paket C — urnik (en val)

> **DOSTAVLJENO v valu 22** (C1 `schedule.dates` celodnevni override + nameren temen dan; C2 replay materializacija — docs/auto-radio.md "Paket C").

| # | Predlog | zasnova |
|---|---|---|
| C1 | **Datumsko-vezane pojavitve**: `schedule.dates["2026-12-25"] = [...]` — override celega dneva (prazniki, enkratni dogodki) + pravilo "ta datum preskoči ponovitev" (npr. božič prekine tedensko predlogo). stationWriter (atomarno, kot vedno) + scheduleGrid + studio UI + MCP orodje (29 → 30). |
| C2 | **Replay/ponovitve**: nov tip occurrence `replay` → ob dnevu zaigra obstoječo epizodo; `djAudio` predpomnilik že obstaja PO oddaja/datum (djAudio.js:1-7), torej je temelj NIZKA cena. LibreTimeov ekvivalent: rebroadcast/Linked. Pazljivo: ločena zgodovina predvajanj, da replay ne zabriše statistike prvega etra. |

### Paket D — formatna ura (največji skok; ločen val, odločitev vred)

> **DOSTAVLJENO v valu 23** (`scheduler/formatClock.js`, OPT-IN `config.imaging.beds`, 40 testov — docs/auto-radio.md »Paket D (Val 23)« in docs/imaging-layer.md §5). Promo slot iz spodnjega besedila je pokril že B2 (Val 21), zato D1 prinaša vreme ob `:15`/`:45` in napoved naslednje oddaje kot postelji.

**D1: Urni predlogi prek obstoječih postelj.** Fiksna mesta v uri — vreme ob `:15`/`:45`
KOT POSTELJA (`beds.push` mehanizem ŽE obstaja s sidechain duckerjem — govorna
rubrika čez utišano glasbo, natanko "napoved čez dan"), napoved naslednje oddaje N
minut pred preklopom KOT POSTELJA, promo slot. Nodeova stran: urni job, ki ob pravih
minutah producira klip (vreme že ima vir: ARSO v feeds.js) in potisne v posteljo.
To je natanko "samodejna produkcija → postelja", ki jo docs/imaging-layer.md:28
imenuje za "ločeno prihodnjo odločitev" — **raziskava jo je predlagala, Val 23
pa dostavil**.
Velikost: srednje velik val; tveganje nizko (postelje so že v produkciji), a zahteva
nov scheduler job + produkcijo klipov na minutni takt.

### Prioritete (priporočilo orkestratorja)

- **Val 20 = Paket A** (vse štiri hitre zmage skupaj — vsaka je sama majhna, skupaj
  zaokrožena zgodba "postaja zdaj sliši kvadrante in pravilno napoveduje") — dostavljen.
- **Val 21 = Paket B** (napovedi — najvišja čista uporabniška vrednost: B1 govorna
  napoved naslednje oddaje je tisto, kar iskalec te raziskave išče pod "napovedi") — dostavljen.
- **Val 22 = Paket C** (datumi + replay) — dostavljen.
- **Val 23 = Paket D** (formatna ura — najbolj "profesionalen" zvok, največji obseg) — dostavljen.
- **Zavrnjeno s podanim razlogom**: (a) Websocket/SSE push now-playinga — AzuraCast
  potrebuje Centrifugo zaradi 1000+ sočasnih poslušalcev; naš polling za eno-družinsko
  postajo ni ozko grlo in bi pomenil novo mini-storitev; (b) skupnostni katalog — že
  zavrnjen (subwave-deep-analysis.md:162 "nismo platforma"); (c) zanka
  analitika→rotacija — lepa, a brez merljive koristi za obseg postaje; ostaja na
  seznamu zamisli.

---

## 6. Zaključek

Radio Markecov **mehanski** sloj (urnik-swapy, atomska vztrajnost, rotacijska
pravila, imaging plasti, celovod produkcije) je v celoti primerljiv z najboljšimi
odprtokodnimi sistemi — kje drugod celo vodi. Ob raziskavi (2026-10-26) je bila
tanka **programska** plast nad njim: kvadranti dneva so bili neslišni, napovedi so
se končale pri skladbi, promosi niso obstajali, prazniki niso mogli obstati.
Paketi A–D (Valovi 20–23) so te štiri vrzeli zaprli — kolo kvadrantov je slišno,
oddaje se govorno napovejo (zaključna napoved, promo plast, postelje formatne ure),
prazniki in enkratni dogodki živijo v `schedule.dates`, replay pa znova zaigra
izvirno epizodo. Ta raziskava je od takrat zgodovina kot opis stanja; kot seznam
zamisli je izčrpana.

*Raziskava 19-a (preslikava naših zmožnosti) je zapisana v worklogu; ta dokument je
nosilec primerjave in predlogov za nadaljnje vale.*
