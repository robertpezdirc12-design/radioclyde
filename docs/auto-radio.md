# Radio Markec — samo skripte, brez AI modelov

Ta dokument opisuje delovanje Radio Markec: popolnoma deterministično
radijsko postajo **brez jezikovnega modela in brez nevronskih TTS modelov**
("samo skripte brez AI modelov", Val 28). Glasba se izbira po pravilih,
govor se sestavlja iz predlog, zvok pa prihaja iz vnaprej posnetih posnetkov
ali klasičnih sintetizatorjev (Windows SAPI / espeak-ng) ter Edge/Piper
stevilskih glasov.

> Zgodovina (Val 28): postaja je nekoč imele DVA načina — "AI način"
> (LM Studio qwen3.6-35b-a3b + Chatterbox TTS) in avtomatski način za
> zastavico `autoRadio.enabled`. V valu 28 je bila CELA AI plast odstranjena
> po direktivi lastnika: avtomatska pot je edina pot. Stari konfiguracijski
> ključi (`lmStudio`, `chatterbox`, `autoRadio.enabled`) so mrtvi — postaja
> jih ignorira, `npm run doctor` pove, da jih lahko izbrišeš, in
> `test/noAiModels.test.mjs` pazi, da se plast ne vrne.
>
> `test/goldenChain.test.mjs` (Val 29) je dinamični dvojnik tistega
> stražarja: en sam test poganja CELO verigo skozi prave vstopne točke —
> knjižnica → autocue merjenje → filler playlista → `generateScript` →
> `directShow` → doctorjevo preverjanje #19 "prehodi" — in trdi, da končni
> `playlist.m3u` res nosi izmerjene žige (fade-in po glavi, crossfade po
> repu, washout/dissolve/sweep). Stražar iz valu 28 pini STATIČNO, da AI
> datoteke ne obstajajo; zlata veriga pini DINAMIČNO, da cev teče.

## Kaj je bilo nekoč AI — in kaj je zdaj

| Faza | Nekoč (AI način) | Zdaj (edini način) |
|---|---|---|
| Razlaga briefa (»## Track Selection«) | LLM (`producer/trackSelection/query.js`) | deterministični parser (`auto/briefQuery.js`) |
| Izbira skladb | deterministična (`trackSelection/queue.js`) | ista koda + dodatna pravila (`auto/rules.js`) |
| Raziskava dejstev | Wikipedia (`producer/research/`) | metapodatki iz knjižnice (izvajalec, naslov, album, leto, žanr) |
| Pisanje DJ vrstic | LLM (`producer/moves.js`, `boundaryWalk.js`) | predloge (`auto/templates.js`, `scriptBuilder.js`) |
| Pregled skripte | LLM (`producer/reviewScript.js`) | ne potreben (predloge se ne ponavljajo) |
| Žive segmente (čas/vreme) | LLM (`director/liveSegments.js`) | predloge + pravi podatki Open-Meteo (`auto/liveLines.js`) |
| Glas (TTS) | Chatterbox (`director/tts.js`) | posnetki / Edge / Piper / SAPI / espeak / brez (`auto/voice.js`) |

Vse ostalo — urnik (`station.json`), predkúšnja (prewarm), direkcija,
`playlist.m3u`, spletna stran, studio, Android aplikaciji, scrobbling — dela
enako kot prej.

## Nastavitev

1. V `config.json` dodaj blok `autoRadio` (glej `config.example.json`).
2. Bloka `lmStudio` in `chatterbox` ter ključ `autoRadio.enabled` lahko
   izbrišeš — postaja jih ne bere več (obstoječe namestitve delujejo naprej
   tudi z njimi; doctor javi, da so odstranljivi).

Primer minimalnega bloka:

```json
"autoRadio": {
  "stationName": "Radio Markec",
  "music": { "source": "auto", "localDirs": ["/mnt/glasba"] },
  "rules": {
    "artistCooldownHours": 3,
    "popularityMix": { "popularShare": 0.7 },
    "decadeSpread": true
  },
  "voice": { "mode": "clips", "clipsDir": "voice-clips" }
}
```

## Glasbeni viri: Plex ali lokalne mape

`autoRadio.music.source`:

- `"plex"` — vedno Plex (prejšnje obnašanje; napaka Plexa je napaka).
- `"local"` — vedno lokalne mape (`localDirs`); Plex ni nikoli klican.
- `"auto"` (priporočeno) — Plex, kadar je dosegljiv; ob napaki se ta poizvedba
  izvede iz lokalnih map in zabeleži NOTE v dnevnik.

Lokalni ponudnik (`auto/localLibrary.js`) rekurzivno pregleda mape, prebere
prave ID3/Vorbis oznake (naslov, izvajalec, album, leto, žanr, trajanje) prek
knjižnice `music-metadata` in tvori iste objekte skladb kot Plex — zato
odvod zgodovine predvajanja, izločanje ponavljanj in trajanje oddaje delajo
enako. `ratingKey` je stabilen zgoščen poti datoteke. Izvajalci s poševnico
v imenu (AC/DC) ostanejo cele: ID3v2.3 razglasi »/« za ločilo več vrednosti,
zato se razdeljene dele znova združi z istim ločilom — oznaka je vir
resnice, nič se ne izmisli (regresijski test v `test/localLibrary.test.mjs`).

Omejitve lokalnega načina (jasno prijavljene, ne utišane):

- `singleAlbum` oddaje potrebujejo Plex albumne entitete — v lokalnem načinu
  pride jasna napaka; preoblikuj brief v artist/genre/decade izbor.
- Teme po slogu (»female vocalists«) brez metapodatkov ni mogoče razširiti
  brez modela — v briefu jih zapiši kot izrecni seznam
  `- artists: Ime 1, Ime 2, ...`.

## Pravila izbire skladb (`autoRadio.rules`)

Vse pravile so neobvezna; privzete vrednosti so navedene v oklepaju.

- **`artistCooldownHours` (3)** — isti izvajalec ne sme na zrak v tem
  časovnem oknu, tudi če so vse skladbe različne. Bere dnevnik
  `history/played.jsonl`. Če bi pravilo izpraznilo celoten bazen (ozka oddaja,
  mala knjižnica), se pravilo za to izbiro začasno odpre in to zabeleži.
- **`popularityMix.popularShare` (izklopljeno)** — točen delež izborov iz
  »bolj znane« polovice bazena (delitev po medijani `ratingCount`).
  `0.7` pomeni ~70 % znanih, ~30 % manj znanih skladb.
- **`decadeSpread` (true)** — kandidati se krožno izmenjujejo po desetletjih,
  tako da bazen, ki sega čez več desetletij, njih izmenjuje namesto da bi se
  zgostil v eno.
- **`timeOfDayBlocks`** — preslikava ure v blok (jutro/dan/večer/noč,
  prehodi čez polnoč so pravilni). Blok določa, katero različico pozdrava
  izgovori DJ (glej predloge); njegov neobvezni `preferredGenres`
  (npr. `"night": { "preferredGenres": ["Instrumental"] }`) pa je aktivno
  mehko žanrsko usmerjanje: žanri bloka zožijo bazen kandidatov na skladbe,
  ki ustrezajo kateremu koli od njih (ujemanje neodvisno od velikosti črk in
  diakritikov). Ko ustreznih skladb ni dovolj, da bi napolnile ocenjeno
  potrebo oddaje po številu skladb, zožitev takoj odneha — in to pošteno
  zabeleži —; briefova lastna izbira vedno zmaga nad razpoloženjem bloka,
  žanrski filter ni nikoli trdna prepoved. Blok se razreši ob produkciji
  (predgretje teče v oknu mrtvega časa pred slotom, torej produkcijska ura,
  ne ura predvajanja) — enaka semantika kot različice pozdravov, ki zdaj
  resnično pridejo na zrak.

Dodatno veljajo obstoječa pravila postaje: `shows.repeatWindowDays`
(posamezna skladba), `neverPlay` (station.json), trajanjske omejitve briefa
(»no track longer than 5 minutes« itd.).

## Govorjenje brez modelov (`autoRadio.voice`)

`autoRadio.voice.mode` izbere enega izmed sedmih virov — nobeden ni lokalni AI model:

- **`edge`** — Microsoft Edge nevronska sinteza (privzeti priporočeni način):
  pravi nevronski slovenski glasovi **`sl-SI-PetraNeural`** (ženski) in
  **`sl-SI-RokNeural`** (moški), brez API-ključa in brez lokalnega modela —
  ista storitev, ki jo uporablja Edgejev "Glasno branje". Glas po osebi:
  `voice.personas.<ime>.edgeVoice`, sicer `voice.edgeVoice`
  (privzeto `sl-SI-RokNeural`). Storitev je neuradna in lahko zavrne
  (npr. HTTP 429) — takrat segment pade na `voice.edgeFallback`
  (`clips`/`sapi`/`espeak`/`none`, privzeto `none` = spusti segment), z
  enakim "spusti, ne mirovaj" dogovorom kot manjkajoči posnetek.
- **`piper`** — lokalna nevronska sinteza prek **piper1-gpl** runtime-a
  (`piper-tts` 1.8.0 s PyPI, aktivni naslednik arhiviranega rhasspy/piper —
  P3 #15). Glas je bodisi glas-ključ `sl_SI-artur-medium` (prenaša se ENKRAT
  ob prvi uporabi prek `piper.download_voices` s HuggingFace, ~63 MB; kasneje
  brez omrežja) bodisi stara pot do `.onnx` datoteke (še vedno veljavna).
  Glas po osebi: `voice.personas.<ime>.piperVoice` (+ neobvezno
  `piperSpeaker` za večgovorniške modele), sicer `voice.defaultPiperVoice`;
  predpomnilnik ključev: `voice.piperDataDir` (privzeto
  `<dataDir>/piper/`); prenos ob prvi uporabi se izklopi z
  `voice.piperAutoDownload: false` (napaka pove točen ročni ukaz).
  Izhod 22 050 Hz mono — normalizacija na 24 kHz spodaj opravi preostanek.
- **`clips`** — vnaprej posneti posnetki: `<dataDir>/<clipsDir>/<oseba>/<slot>.wav`
  (npr. `voice-clips/elena/intro.wav`), rezervna mapa `default/`. Številčne
  različice (`intro-1.wav`, `intro-2.wav` …) se izbirajo z istim zgoščevalnim
  semeni kot besedilna predloga, tako da besedilo in zvok ostajata usklajena.
  Manjkajoč posnetek pomeni: ta govorjeni segment spusti, glasba teče naprej,
  v dnevniku je NOTE. Glej `sample-data/voice-clips/README.md` za popoln
  seznam slotov.
- **`sapi`** — Windows SAPI (System.Speech) izgovori izrisano besedilo
  predloge. Glas po osebi: `voice.personas.<ime>.sapiVoice`
  (npr. `"Microsoft Matej"`), neobvezno `rate`.
- **`espeak`** — espeak-ng (Linux/brez namestitve modelov). Glas:
  `voice.personas.<ime>.espeakVoice` oz. `voice.defaultEspeakVoice`
  (privzeto `"sl"`), neobvezno `wordsPerMinute`.
- **`pregenerated`** — track in splošni sloti iz `dataDir/pre-generated/`
  (jih polni `pre-generate-clips.mjs` prek istega piper sloja); manjkajoči
  slot spusti segment kot v `clips` načinu. Od valu 27 intro/recap klipi
  zrendajo skozi POSTAJINE predloge (`renderSlot`, seme = slug pesmi --
  deterministično na pesem), torej isti register in isti
  `autoRadio.templates` prepisi kot vse ostalo; posneti klipi se ne
  spremenijo sami od sebe -- po valih, ki spreminjajo besedila, jih
  pregeneriraj.
- **`none`** — brez govora sploh: postaja predvaja glasbo (+ jingle), vsa
  besedila pa ostanejo v `script.md`/`transcript.json`.

Vsi viri se ob prvi uporabi normalizirajo v pcm_s16le/24 kHz/mono (davni
kodekski dogovor govorne plasti), zato spajanje sosednjih govornih odsekov
ostaja brez izgub. SAPI/espeak/edge/piper izhod dobi še `djDrops.gain`;
posnetki (clips, pregenerated) ostanejo netaknuti.

### Govorni stil: naravno, pogovorno, hecavno (P4 #24)

Cilj govora je, da TTS ne zveni kot napovednik prikazovalnika, ampak kot
ta isti, ki se heca za mikrofonom. Pravila, ki jih držimo pri novih
predlogah:

- **Pogovorni ritem:** kratki stavki, naravni vezniki (»no pa«, »tokrat«,
  »samo zavedite se«); uradne fraze (»v skladu s programsko shemo«) ne.
- **Hec na pravi strani mikrofona:** šale gredo na skladbe, izvajalce,
  mikrofon ali na DJ-ja samega -- nikoli poniževalno na poslušalca.
  »Kdor ugane, dobi rundo aplavza« je hec; »kdor ne zna, naj posluša
  drugje« pa ne.
- **Čisti slovenski jezik:** brez angleških vpadov, kjer obstaja slovenska
  beseda.
- **TTS-prijaznost:** brez oklepajev, brez okrajšav, brez smejkov;
  številke izpisane ali pripravljene za izgovorjavo; pomišljaj » -- «
  izgovorjamo kot kratko pavzo, uporabljamo ga zmerno.
- **Deterministična rotacija:** vsaka šala je nova različica v obstoječem
  bazenu predloge; zgoščevalnik za isto oddajo in datum izbere vedno isto
  različico -- humor je torej reproducirljiv, ne naključen.

Za čisto slovenščino sta trenutno najbolj naravna vira edge
`sl-SI-PetraNeural`/`sl-SI-RokNeural` (nevronska, brez modela na boxu) in
piper `sl_SI-artur-medium` (~63 MB, povsem offline). Online storitve s
slovenskimi glasi (ElevenLabs, Narakeet, speechgen.io) zvenijo sorodno, a
zahtevajo račune in API-ključe -- v autoRadio ostajajo zunaj obsega
(ni modela, ni ključa, ni naročnine).

**Tempo in ton (P4 #26, iz raziskave TTS naravnosti):** ritem JE naravnost
-- malo počasnejša izreka zaznavamo kot mirno in človeško, hitrejšo kot
navezano. Zato imata oba glavna vira prozodični nastavitvi (po osebi ali
globalno): edge -- `voice.edgeRate`/`edgePitch`/`edgeVolume`
(npr. `"-8%"` za sproščeno, `"-2Hz"` za mehkejši ton; oseba preko
`voice.personas.<ime>.edgeRate`), piper -- `voice.piperLengthScale`
(npr. `1.08`; pod 1 hitreje, nad 1 počasneje). Pisateljska pravila ostanejo
isti najmočnejši vzvod: ločila so pavze, kratki stavki vremejo ritem,
dolgi ga upočasnijo -- predloge nad tem pišemo od začetka.

**Sproščen register (Val 27):** `config.example.json` od zdaj privzeto
nastavi `voice.edgeRate: "-6%"` -- namestitve po predlogi dobijo sproščen
tempo (≈ 150–160 besed/min, pogovorni ritem radijskega voditelja) brez
rokovanja po nastavitvah. Obstoječe namestitve se ne spremenijo: prazen
prozodični blok pošlje enako zahtevo kot prej (P4 #26 pogodba). Pisateljska
stran istega vala: privzete predloge zdaj govorijo sproščen rockerski
register (glej razdelek Predloge), enote so izpisane (»21 stopinj«, ne
»21 °C« -- okrajšave TTS prebere črko po črki), test
`test/voiceRegister.test.mjs` pa lintrost stropa: stavki, filtri in oklepaji.

## Rubrike (`autoRadio.rubrics` / vrstica `Rubrike:` v briefu)

Poleg glasbe lahko oddaja prebere **resnične podatke** iz slovenskih virov —
vedno deterministično, brez jezikovnega modela. Oddaja jih zahteva z vrstico
`Rubrike:` v briefu (šumniki so neobčutljivi):

```markdown
Rubrike: vreme, novice, šport, obzorje, zanimivosti, glasba
```

| Rubrika | Vir | Slot | Predloga |
|---|---|---|---|
| `vreme` | **ARSO** — uradna meteorološka služba RSS (opazovanja, ~20 slovenskih postaj, slovenski opisi). Od P4 #29 ima **pošteno offline vrstico** (`weatherOffline` — brez izmišljenih podatkov), ko je ARSO nedosegljiv | `weatherNow` / `weatherOffline` (rezerva) | `weatherNow.withTemp` / `.tempOnly` / `.generic`; rezerva `weatherOffline` |
| `šport` | **RTV Slovenija** športni RSS — sveže naslovnice. Od P4 #30 ima **pošteno offline vrstico** (`sportOffline` — brez izmišljenih rezultatov), ko je vir nedosegljiv ali prazen | `sportHeadlines` / `sportOffline` (rezerva) | `sportHeadlines`; rezerva `sportOffline` |
| `novice` | **RTV Slovenija** novični RSS — naslovnice iz Slovenije in sveta. Od P4 #30 ima **pošteno offline vrstico** (`newsOffline` — brez izmišljenih naslovnic), ko je vir nedosegljiv ali prazen | `newsHeadlines` / `newsOffline` (rezerva) | `newsHeadlines`; rezerva `newsOffline` |
| `obzorje` | **Wikidata** — rojstva/smrti na današnji dan, samo entitete s slovensko oznako, spol iz P21 (rodil/rodila, umrl/umrla). Od P4 #30 ima **pošteno offline vrstico** (`obzorjeOffline` — brez izmišljenih imen in let), ko je arhiv nedosegljiv ali za ta dan ne vrne nič | `obzorje` / `obzorjeOffline` (rezerva) | `obzorje.birth`/`.birthF`/`.death`/`.deathF`; rezerva `obzorjeOffline` |
| `glasba` | **Wikidata** — isto kot `obzorje`, a filtrirano na glasbenike (poklic P106, podrazredi Q639669 "glasbenik") — rubrika "Na današnji dan v glasbi". Od P4 #28 ima **lokalni korpus** (`src/auto/onThisDayFacts.js`, deluje brez omrežja) kot rezervo, ko Wikidata ni dosegljiva ali za ta dan nič vrne | `obzorjeGlasba` | `obzorjeGlasba.birth`/`.birthF`/`.death`/`.deathF` |
| `zanimivosti` | **MusicBrainz** (leto nastanka, država, žanri za skupine) + **sl.wikipedia** povzetek kot rezerva + **lokalni korpus** splošnih rock zanimivosti (`src/auto/rockFacts.js`, deluje brez omrežja) | `triviaArtist` / `triviaGeneral` | `triviaArtist` / `triviaGeneral` |
| `kviz` | **lokalni korpus vprašanj in odgovorov** (`src/auto/quizFacts.js`, 40 ročno kuriranih vprašanj z enim preverljivim odgovorom — deluje brez omrežja) | `quizIntro` / `quizReveal` (ob sredinski skladbi briefa z `quiz` segmentom) | `quizQuestion` / `quizAnswer` (letno ugibanje ostane kot rezerva) |
| `anketa` | **lokalna datoteka ankete** (`dataDir/polls.json`, upravlja prek API `/api/polls` — brez omrežja, deluje tudi offline; brez aktivne ankete segment preprosto ni na sporedu) | `pollRunning` (brez glasov) / `pollResults` (pošteno trenutno stanje) | `pollRunning` / `pollResults` |
| `poslušalci` | **lokalna datoteka zahtevkov** (`dataDir/requests.jsonl`, odobri prek studia — brez omrežja, deluje tudi offline; SAMO sveže odobrene zahtevke/posvetila v 12 h oknu, nastavljivo `rubrics.listenerLimit`/`listenerWindowHours`) | `requestShout` / `dedicationShout` (na zahtevek) | `requestShout` / `dedicationShout` |

Nastavitve v `config.autoRadio.rubrics`:

- `station` — ARSO postaja (npr. `"Ljubljana"`; ujemanje: točno → začne se z →
  vsebuje-najkrajše, tako da `"Ljubljana"` najde mestno postajo, ne letališča)
- `newsLimit` — koliko novičnih naslovnic (privzeto 3)
- `sportLimit` — koliko športnih naslovnic (privzeto 4)
- `onThisDayLimit` — koliko dogodkov "na današnji dan" (privzeto 2)
- `onThisDayMusicLimit` — koliko glasbenih dogodkov "na današnji dan" (privzeto 2)
- `triviaMaxArtists` — na koliko unikatnih izvajalcev na oddajo se sploh poizveduje (privzeto 6)
- `triviaGeneralCount` — koliko splošnih rock zanimivosti na oddajo iz korpusa (privzeto 3)
- `quizCount` — koliko kviz vprašanj na oddajo iz korpusa (privzeto 1; 0 izklopi resnično vsebino in pusti staro ugibanje leta)
- `timeoutSeconds` — trdi časovna omejitev za vsak vir (privzeto 10)

Dogovor je vedno enak: **vir odgovori → segment je v oddaji; vir odpove ali
čas poteče → segment spusti, oddaja teče dalje.** Od P4 #28/#29/#30 velja
dopolnitev: vse rubrike imajo lokalno pokritost, zato ob mrtem
usmerjevalniku NE izginejo — `vreme` na zrak gre s pošteno offline vrstico
(brez izmišljenih podatkov), `glasba` z lokalnim korpusom, `novice`, `šport`
in `obzorje` s poštenimi offline vrsticami (brez izmišljenih naslovnic).
Odgovori so v procesu predpomnjeni (vreme 15 min, šport 30 min, obzorje 6 h,
izvajalec 24 h), tako da prewarm in ponovni zagoni ne obremenjujejo virov.
Rubrika ni del oddaje, če je ni v briefu; `--offline` (predogled) omrežne
vire spusti — ostanejo: `kviz` (cela), `anketa`, `poslušalci`, korpusna
polovica `zanimivosti`, korpus `glasbe` in poštene vrstice `vremena`,
`novic`, `športa` in `obzorja`; spusti se le še net-polovica `zanimivosti`
za izvajalce (MusicBrainz/sl.wikipedia — podatka o izvajalcu ne moremo
izmisliti, korpusna polovica pa seveda ostane).

### Kviz — resnična vprašanja na obstoječem mestu (P4 #22)

Brief z `quiz` v vrstici **Segments:** že od začetka odpre kviz položaj:
sredinska skladba dobi `quizIntro` (namesto navadnega `intro`) in
`quizReveal` (namesto `recap`). Brez rubrike `kviz` tam zazveni staro
ugibanje leta iz metapodatkov skladbe. Z rubriko — ključna beseda `kviz`
(v ali `quiz`) v vrstici `Rubrike:` — pa se na to mesto postavi **resnično
vprašanje** iz korpusa `src/auto/quizFacts.js` (»Kdo je ustanovil Iron
Maiden?«), odgovor pa razkrije takoj po skladbi (»Pravilen odgovor: Steve
Harris.«). Vprašanja se rotirajo po zgodovini rocka (kronološko) glede na
seme `oddaja|datum`, zato vsak dan drugo vprašanje, isti dan pa vedno isto
(reproducirljivi prepisi, predpomnljivi zvok). Vsebina je povsem lokalna —
ta rubrika je edina, ki v `--offline` načinu deluje CELA. Od P4 #23 rubriko
kviz uporabljajo tudi **vse tematske oddaje** (glej §Tematske oddaje).

Predloge za vsebino so `quizQuestion` (vsebuje `{question}` in obljubo
»odgovor takoj po skladbi«) in `quizAnswer` (vsebuje `{answer}`); stari
`quizIntro`/`quizReveal` ostanejo rezerva. V clips načinu lahko oba slotita
posnameš posamezno (`voice-clips/<persona>/quizIntro.wav`,
`quizReveal.wav`); v načinu predgeneriranih klipov kviz slot v trajanje
uporabi intro/recap klip te skladbe — prepis pa vedno nosi pravo
vprašanje.

Od P4 #24 je bazen predlog bolj razposajen: `quizQuestion` ima šest
različic (od strožje »Kviz za pozorne poslušalce« do »Malica za možgane,
vstop brezplačen« in »Kdor ugane, dobi rundo aplavza«), `quizAnswer` tudi
šest (od »Rešitev kviza« do »Kdor je zadel, mu dolžim eno pivo -- izplačilo
ob naslednjem srečanju«). Vsaka različica ohranja isti dogovor: vprašanje
vsebuje obljubo o odgovoru takoj po skladbi, odgovor pa izrecno
»Pravilen odgovor«/»Rešitev kviza« -- test `test/quiz.test.mjs` (razdelek
E) ta dva namiga zapne, konfiguracijski prepisi pa ostanejo kompatibilni.

### Wikimedia iz podatkovnih središč (HTTP 403) — živo opaženo

Wikimedia blokira celotne obsege IP-jev podatkovnih središč: iz oblaku
`query.wikidata.org`, `www.wikidata.org` in vse wikipedije vračajo **HTTP 403
v ~150 ms** (enako za brskalnik in prazen uporabniški agent, torej blokada
obsega, ne uporabniškega agenta). V tem primeru se `obzorje`, `glasba` in
wikipedijina rezerva `zanimivosti` vsako produkcijo pošteno spustijo — v
`station.log` je to prepoznavno kot »`query failed (HTTP 403 from Wikidata)
-- rubric skipped`« oziroma »`brez zanimivosti (HTTP 403 from sl.wikipedia)`«
— oddaja pa teče naprej na ARSO, RTV, MusicBrainzu in korpusu. Pri zgoščenem
ponavljanju produkcij lahko iste wikipedije iz istega okolja včasih vrnejo
tudi **HTTP 429** (omejitev pogostosti, ne blokada) — podpis v dnevniku je
enake oblike, pomen za oddajo pa enak. Domači in
pisarniški IP-ji težave nimajo (WDQS ne potrebuje ključa, le uporabniški
agent). Odpravljanje: poglej `station.log` na »403 from Wikidata«; rešitev je
gostovanje na IP-ju, ki ga Wikimedia ne blokira, ali izhodni posrednik
takšnega IP-ja. MusicBrainz, ARSO in RTV niso prizadeti.

### Kako se zanimivosti razporedijo po oddaji

Zanimivosti so zavestno redkejše od ostalih rubrik: pridejo **pred uvod
vsake tretje skladbe** (druga, peta, osma, ... skladba v oddaji). Na tem
mestu ima prednost **dejstvo o izvajalcu, ki sedaj igra** (samo prva
pojavitev izvajalca v oddaji, ena poved na izvajalca); če za njega ni
resničnega podatka, pade na vrsto **splošna rock zanimivost** iz korpusa
(kitare, albumi, nastopi — vključno s slovenskimi, kot so Pankrti).

Za izvajalce velja veriga brez ugibanj: MusicBrainz poveže samo **skupino**
(type `Group`) z ujemajočim se imenom (šumniki in ločila brez pomena);
za pevce in vse, česar MusicBrainz ne najde, poskusi povzetek s
sl.wikipedia — ampak samo, če stran ni razločevalna in se naslov
udeja s poizvedbo. MusicBrainz se poizveduje največ enkrat na sekundo
(uradna omejitev) in z obveznim uporabniškim agentom; rezultati so
predpomnjeni 24 h na izvajalca. Pod zgoščenimi ponovljenimi produkcijami
(testni nizi, več zagonov v enem valu) MusicBrainz občasno vrne 503 —
takrat rubrika segment pošteno spusti in oddaja nadaljuje na korpusu,
kot pri vsaki drugi spodleteli poizvedbi.

V `clips` načinu so novi sloti posnetljivi posamezno: `triviaArtist`,
`triviaGeneral` in `obzorjeGlasba` — manjkajoč posnetek spusti samo ta
segment, kot za vse ostale.

## Predloge (`autoRadio.templates`)

Privzete predloge so slovenske (glej `src/auto/templates.js`) in od valu 27
govorijo **sproščen rockerski register** -- isti glas, ki ga je persona
Markec Podkasta (P5 #1) že dokazala na etru: kratki pogovorni stavki,
redki diskurzni filtri (največ EN na varianto, sidrani na vejico ali
pomišljaj -- »No,«, »Tako --«, »Glejte,«; seznam izvožen kot
`DISCOURSE_MARKERS`), suha ironija namesto sporedniške formalnosti,
enote izpisane besedno, brez oklepajev kadarkoli (berejo se kot odre,
ne govor). Bazeni so debeli (4–6 različic, kjer pogodbe dovoljujejo), ker
tanek bazen + zgoščevalna izbira je natanko to, kako sintetična postaja
začne ponavljati sebe. Vse to lintro `test/voiceRegister.test.mjs`
(minimumi različic, proračun filtrov ≤1, stropi stavkov ≤18/≤24 besed,
brez oklepajev). Vsak slot je
niz različic; konkretna različica se izbere z zgoščevalom
(oddaja|datum|ratingKey|slot) — ista oddaja vedno isto, različne dni pa se
izmenjujejo brez modela. Vrednosti, ki jih lahko uporabiš:

| oznaka | pomen |
|---|---|
| `{station}` | ime postaje (`autoRadio.stationName`) |
| `{show}` | naslov oddaje |
| `{artist}` / `{title}` | izvajalec / naslov skladbe |
| `{album}` / `{year}` / `{decade}` / `{genre}` | metapodatki skladbe |
| `{to}` | oseba, ki prevzame vremensko napoved |
| `{fact}` | zanimivost (polna poved brez končne pike — predloga jo dodaja) |
| `{time}` / `{date}` | trenutni čas/datum v `weather.timezone` |
| `{condition}` / `{temp}` / `{wind}` | vreme (slovensko; enote izpisane -- »stopinj«, »kilometrov na uro«) |
| `{nextShow}` / `{nextHost}` / `{nextTime}` / `{nextDayWord}` | zaključna napoved naslednje oddaje (ime, voditelj, ura, slovenska dnevna beseda »danes«/»jutri«/»v sredo«) — razrešeno ob režiji, glej razdelek o njej spodaj |

Sloti: `open` in `close` imajo tudi različice po časovnih blokih
(`morning`/`daytime`/`evening`/`night` + `default`) — različico izbere blok,
razrešen ob produkciji (`scriptBuilder` ga razreši enkrat na izgradnjo
oddaje, isti blok kot žanrsko usmerjanje); `recap` se sam odloči
med različicami z albumom+letom, samo letom ali splošno — glede na to, kaj
knjižnica res ve. Preprost kviz (ugibanje leta) uporablja `quizIntro` in
`quizReveal`. Živi sloti (`live:time`, `live:weather`, `live:time-weather`)
se polnijo z reliefnimi podatki ob režiji; zaključna napoved naslednje
oddaje ima svoj par bazenov — `live.nextShow.withHost`/`noHost` (razcep
po voditelju, tako da oddaja brez voditelja nikoli ne izreše obvislega
»z voditeljem«) in pošteno rezervo `live.nextShowOffline` (glej razdelek
»Paket B1« spodaj).

Poljuben slot lahko prepišeš:

```json
"templates": {
  "intro": [
    "Zdaj sledi {artist} s skladbo {title}.",
    "Na vrsti je {artist} z naslovom {title}."
  ]
}
```

## Deterministični brief

Razdelek `## Track Selection` v `show-descriptions/*.md` razume (poleg
običajnega proznega zapisa) izrecne vrstice — te imajo vedno prednost:

```
- artist: Elvis Presley          (ali: izvajalec)
- genre: Pop/Rock                (ali: zanr; mora biti resnična oznaka v knjižnici)
- decade: 1980                   (ali: desetletje)
- artists: Ime 1, Ime 2          (seznam izvajalcev za teme)
- album keyword: Disney
- album genre: Instrumental
- folder: /volume1/media/_soundtrack
- exclude: christmas, soundtrack (ali: izkljuci)
- max track length: 5 minutes
- min track length: 2 minutes
```

Prozni zapis je prav tako podprt in je negacijam zaveden: »Don't repeat the
same artist«, »No track longer than 5 minutes«, »Favor well-known tracks«,
»No christmas tracks« (razširi na ključne besede) — vse se prepozna brez
modela. Vsa ostala proza se ignorira.

Vzorčni brief za ta način: `sample-data/show-descriptions/80s-rock-auto.md`.

## Tematske oddaje (P4 #18: katalog + tedenski special)

Katalog štirinajstih kuriranih tematskih oddaj (`src/auto/showCatalog.js`)
izriše **prave** `show-descriptions/*.md` brife — z vsemi pravili izbire in
vrstico `Rubrike:` — tako da za poljubno temo (»Zgodovina rocka«, »Zgodovina
kitare«, »Veliki nastopi«, portreti desetletij, rock nekdanje Jugoslavije,
punk in novi val, »Blues korenine«, »Trdi rock in metal«, »Progresivni rock«,
»Ženske v rocku«, album v celoti) ni treba ročno pisati briefa. Vso mehaniko
(izbira skladb, rubrike, zanimivosti, govor) nato opravi obstoječi cevovod,
nespremenjen.

**Tedenski special slot** v `station.json`:

```json
{
  "id": "special",
  "startTime": "20:00",
  "durationMinutes": 60,
  "special": {
    "themes": ["zgodovina-rocka", "zgodovina-kitare", "veliki-nastopi"],
    "personas": ["elena"]
  }
}
```

- **Rotacija po ISO tednu**: tema za določen teden je
  `themes[isoTeden % themes.length]` — znotraj istega ISO tedna vsi dnevi
  (vključno z večerno pripravo za ponočni slot) razrešijo isto temo, vsak
  teden naprej, po koncu kataloga znova od začetka.
- **Razrešitev na dveh mestih**: `loadSchedule()` razreši special vnos za
  prikaz (spored, now-playing, prihajajoče takoj pokažejo naslov teme),
  produkcija (`generateScript`) pa ga ponovno razreši na **pravi datum
  oddaje** — edini primer, ko se tedna razlikujeta, je priprava v nedeljski
  noči za ponedeljkovo polnoč. Brif se materializira v
  `show-descriptions/themed/<tema>.md` (prepiše se le, ko se vsebina spremeni,
  torej ob posodobitvi kataloga).
- **Personas**: `special.personas` ima prednost; privzeto prvi persona iz
  `prompts.json`.
- **Kviz (P4 #23)**: vsak tematski brif odpira kviz položaj — pred sredinsko
  skladbo zazveni vprašanje iz korpusa (`quizFacts.js`), odgovor pa takoj po
  njej. Brifi, materializirani pred P4 #23, se ob naslednji produkciji sami
  osvežijo (idempotenca `ensureThemedBrief`); z `rubrics.quizCount: 0` kviz
  vsebine ni in na položaju zazveni staro ugibanje leta.
- **Neuspeh je pošten**: tema, ki v knjižnici ne najde skladb (npr.
  »Zgodovina kitare« brez kitaristov v izvajalcih ali »Veliki nastopi« brez
  albumske oznake »Live«), konča z znanim »resolved zero tracks« in ura pade
  na polnilo — enako kot ročno napisan brief. Napačno nastavljen `special`
  ne poruši branja urnika: gre skozi surov in produkcija vrže enako sporočilo
  napake.
- Tematske brife lahko pred ogledom tudi ročno materializiraš
  (`npm run themed-shows -- ensure <tema>`) in jih urejaš kot običajne — ob
  naslednji produkciji pa jih samodejno osveževanje prepiše s katalogom,
  če se vsebina razlikuje.

## Doctor + cron vzorec pred vsako terminirano uro

Predvečerna diagnostika (`npm run doctor`, P4 #31, `src/cli/doctorCli.js`) je
EN ukaz, ki operaterju pred terminirano uro pove, ali bo oddaja preživela:
konfiguracija, podatkovna mapa, govor, knjižnica, ledger, korpusi, (z
`--net`) dostopnost virov IN šest SUB/WAVE preverjanj (oddajnik, telnet,
predvajalne liste, shramba, gostitelj, dnevnik napak — glej razdelek P4 #31)
— z istimi pogodbami kot oddaja sama (skip-not-fail; mrtvi vir je OPOZORILO,
ne napaka; `--json` za strojni izpis). Ta razdelek
pokriva dopolnilo **(c)**: dogovorjeni »cron vzorec« — doctor naj bi tekel
**tik pred vsako terminirano uro**, cron pa ne zna brati station.json.

Zato vzorec izpeljemo iz pravega urnika:

```sh
npm run doctor -- --cron [--minutes-before=15]
```

izpiše pripravljene crontab vrstice (za lepljenje v `crontab -e`):

- **vsak DISTINCT začetek termina** dobi po en predhodni pregled — privzeto
  15 min pred začetkom (`--minutes-before`),
- termini tik za polnočjo premaknejo dan-of-teden **za en dan nazaj**
  (ponedeljek 00:05 → nedelja 23:50; ponočni slot torej preveri prejšnji
  večer),
- polni teden (vseh 7 dni) se strne v `*`, enaki začetki v enem vnosu
  dayFielda združijo (`1,3`),
- izhod je sortiran in **bajtno determinističen** — isti urnik vedno isti
  vzorec (čista matematika v `src/lib/cronVzorec.js`, preverjena s testi),
- log priporočeno gre v `<dataDir>/doctor-cron.log`.

Urnik spremeniš → poženi `--cron` → prilepi. Ni ročno vzdrževanih seznamov ur.

## Markec Podkast: 5 minut glasba-klepet-glasba (P5 #1)

`src/auto/podcast.js` zdaj nosi DVA sloja: RSS export produced oddaje (P4
#25, `npm run podcast-export`) IN **generator samostojnih epizod** (P5 #1,
`npm run podcast-gen`) — ta razdelek opisuje generator.

`npm run podcast-gen [-- --date=YYYY-MM-DD --genre=rock --tracks=2 --out=dir]`
zgradi **samostojno petminutno epizodo** — pogovor, glasba, pogovor, glasba,
pogovor — iz realne glasbene knjižnice (plex/local/auto router, enak kot
oddaje) in offline korpusa rock zanimivosti. Zapiše
`<dataDir>/podcasts/<datum>-markec-podkast.md` + `.json` (idempotentno:
isti klic ne dotakne datotek).

**Persona: zajebant, ne kričeči rocker.** Piper TTS kričanje flattenira v
umazan zvok, zato je vsa »rokovska agresija« v izbesci: kratki stavki,
ironija, samokritika, catchphrases — vokalno pa čist glas. Bazeni so v
`autoRadio.templates` (podcastOpen, podcastChat, podcastLaugh, podcastOutro),
prek konfiguracije jih lahko zamenjaš brez kode. Pravila bazenov: brez
oklepajev, brez okrajšav, največ trije stavki na varianto (lint v testih).

- **Determinizem**: epizoda za (datum, bazen, zrno) je bajtno enaka ob vsakem
  zagonu; različni datumi rotirajo skladbe (FNV + stabilna sortiranja),
  variante pogovora in fakt iz korpusa.
- **Skip-not-fail**: manjkajoč fakt → klepet degradira v smešno varianto
  (`podcastLaugh`), epizoda nikoli ne pade zaradi zanimivosti. Prazen žanr v
  knjižnici → poštena slovenska napaka z razpoložljivimi oznakami (exit 1).
- **Petminutni proračun**: skladbe nad 240 s so izpadle, izvajalec se znotraj
  epizode ne ponovi; ocena trajanja je izpisana in ničesar ne izmišljuje.
- Fakt je istega korpusa, ki poganja rubriko »Zanimivosti«
  (`src/auto/rockFacts.js`) — en vir resnice za oddajo in podkast.
### Zvok epizode: Piper sinteza skripte (P5 #2)

`npm run podcast-audio [-- --date=YYYY-MM-DD --genre=rock --tracks=2
--persona=markec --out=dir]` vzame ISTO epizodo kot `podcast-gen` in jo
izriše v **zvočni MP3** (44.1 kHz stereo, 128 kbps, `libmp3lame`):

- vsaka govorjena vrstica ([pogovor] in naznanila skladb) gre skozi
  `src/auto/piperVoice.js` — isti glas, isti config in iste osebne
  nastavitve kot živa oddaja (brez nove resnice o glasu),
- glasbene vrstice vzame iz REALNIH datotek knjižnice (lokalni vir nosi
  `localPath`; pri Plex viru brez datoteke se skladba pošteno preskoči),
- vse sešije ffmpeg concat FILTER (mešani formati/sample ratei so dovoljeni
  na vhodu), poglavja pa se vgradijo iz ffmetadata (ID3 CHAP) + ločena
  `<datum>-markec-podkast-poglavja.txt` za operaterja,
- zamiki poglavij so IZMERJENI s ffprobe, ne izmišljeni; načrt `.json`
  dobi blok `audio` (datoteka, sekunde, dela, pošteni preskoki),
- **skip-not-fail**: vrstica brez zvoka (piper napaka, skladba brez
  datoteke) se belei in epizoda se sestavi iz preostanka — lahko tudi
  samo-govorna; če ne pride skozi NIČ, je to poštena napaka (prazen MP3
  je laž). Če vgradnja poglavij kdaj strmoglavi na eksotičnem ffmpegu,
  sešava pade nazaj na brez-poglavij in vseeno dostavi MP3.

Zahteve: piper1-gpl (`pip install piper-tts`) + glas (ključ ali pot) +
ffmpeg z libmp3lame.

### Cevovod, ki ga dela OBE vrati (CLI + studio gumb)

`src/auto/podcastPipeline.js` je skupno telo obeh podcast CLI-jev IN
studijevega gumba — isti kandidati, ista epizoda, isti plan, isti skip-not-fail
dogovor. Strežniku varen: nikoli `process.exit`, samo poštene napake.
`podcastDate` (CLI brez `--date`) in reuse-check studia računata lokalni
`YYYY-MM-DD` iz `lib/time.js` (`toLocalISOString`) — besedna oblika za žive
vrstice ("Saturday, October 24") tu ne pride v poštev (regresija: živi gumb je
ta bug pripeljal na dan; v CLI-ju je tiholec živel od P5 #1). Še en regresijski
pripet: goli `--out <mapa>` (parseArgs pozna samo `--key=value`) je nekdaj tiho
pisal v `<repo>/true/` — zdaj je to poštena napaka.

## Javni naslov podkasta (P5 #3)

Vsebina je do zdaj obstajala, ni pa imela NASLOVA za poslušalca — največja
nesimetrija iz analize vmesnikov (`docs/ui-admin-vs-poslusalec.md`). Tri rute
iz ene resnice na disku (`<dataDir>/podcasts/`):

- `GET /api/podcast` — arhiv za stran: vse epizode (tudi še brez zvoka,
  pošteno označene), poglavja z izmerjenimi zamiki, javni URL-ji. Osnova
  povezav je `broadcast.publicStreamUrl` (origin) ali izpeljava — isti
  precedens kot `/listen.m3u`.
- `GET /podcast/feed.xml` — **kanalski** RSS 2.0 za podkast aplikacije (Apple
  Podcasts, AntennaPod, …): en kanal, več itemov, enclosure SAMO za epizode z
  zvokom na disku (enclosure brez datoteke bi bila laž). `lastBuildDate` je
  od najnovejše epizode — feed se spremeni natanko takrat, ko se spremeni
  arhiv. Čist gradnik: `buildPodcastChannelFeed` (bajtno determinističen).
- `GET /podcast/<datoteka>.mp3` — zvok z podporo za **Range** (iskanje v
  predvajalniku; 206 + content-range). Trojna obramba: beli seznam znakov v
  imenu, samo `.mp3`, rešena pot ostaja znotraj podcastsDir — traversal
  (`..%2F`) dobi 404, plan `.json` ni javen.

**Objava na javni naslov**: rute so privzeto za Basic Auth (kot vse); lastnik
jih odpre s config vzvodom `web.publicPaths`, npr.
`"publicPaths": ["/podcast", "/api/podcast"]` — istega vzvoda kot `/embed`.

**Stran »Podkast«** (poslušalski vmesnik): nov zavihek — seznam epizod z
vgrajenim predvajalnikom, poglavja, RSS naslov s gumbom »Kopiraj RSS«.
Prazno stanje je izpisano, ne izumljeno.

**Studio gumb** (pogled Shows): kartica »Markec Podkast« z statusom zadnje
epizode in gumbom *Izdelaj današnjo epizodo* — kliče ISTI cevovod kot CLI
(`POST /studio/api/podcast`). Današnja z zvokom = reuse (brez dela), `--force`
izdela znova, sočasni klik dobi 409, napaka pa pošteno prvo vrstico vzroka.

## Javna »najbolj poslušano« (P5)

Analitika je bila samo admin — poslušalcu pa nič ne gre vzeti z malo kode:
`GET /api/top-listened` vrne top 10 skladb tedna po povprečnem številu
poslušalcev med predvajanjem (isti izračun kot studio Analytics —
`listenerImpact.trackImpact` z istimi pragovi `minSamples`/`minCoverage`),
plus pošten kazalec Δ (koliko poslušalcev je predvajanje pridobilo/izgubilo).
Javna površina je namenoma ozka: samo agregati po skladbi — brez ratingKey,
brez ležerja, brez vzorcev, brez IP. Prazno stanje je izpisano z razlogom,
nikoli izumljeno. Kartica živi na poslušalski strani med »Nedavno
predvajano« in priljubljenimi.

## Push obvestilo ob začetku terminirane oddaje (P5 #4)

Zadnja velika asimetrija iz analize vmesnikov: poslušalec mora sam pogruntati,
kdaj njegova oddaja začenja. Zdaj lahko na poslušalski strani (panel »Zdaj«,
kartica »Obvestilo ob začetku oddaje«) vklopi obvestilo — brskalnik ga dobi
tik pred začetkom. Celoten cevovod je brez novih odvisnosti in brez tretjih
API tipk:

- **VAPID par** (`push/vapid.js`, RFC 8292): P-256 par se prvič ustvari
  lokalno z `node:crypto` in leži v `<dataDir>/push/vapid.json`; javna
  polovica gre brskalniku kot `applicationServerKey`. Izguba datoteke = vse
  obstoječe naročnine prenehajo veljati (brskalnik jih zavre) — od vala 18
  jo dnevna varnostna kopija (`backupStation`) dejansko zajame: celotna mapa
  `push/` (vapid.json z mode 0600, naročnine, dnevnik poslanih) gre v vsak
  datumski imenik. Obnova po vrstah: razdelek »Varnostne kopije in obnova«
  v deploy/ubuntu/DEPLOYMENT_GUIDE.md.
- **Šifriranje** (`push/encrypt.js`, RFC 8291 shema `aes128gcm`): payload
  je za push servis Slepa — samo odjemalec s parom `p256dh` ga odšifrira.
- **Naročnine** (`push/subscriptions.js`): `<dataDir>/push/subscriptions.json`
  — najmanjši zapis (endpoint + ključi), brez računov, brez e-pošte, brez
  povezave na osebo. Odjava briše.
- **Dispatch** (`push/dispatch.js` + `scheduler/pushDispatch.js`): schedulerski
  tik `push_dispatch` enkrat na `config.push.checkIntervalMinutes` (privzeto 1)
  pošlje obvestila oddajam, katerih začetek je v oknu
  `config.push.leadMinutes` (privzeto 2) minutah. Idempotentnost:
  poslani termin gre v `<dataDir>/push/sent.jsonl`, zato restart nikoli ne
  pošlje dvakrat. Mrli endpointi (404/410) se obrežejo. Oddaja, ki jo je
  zamudil strežnik (minutesUntil < 0), se NE pošlje — brez zastarelih
  obvestil.

Rute: `GET /api/push/vapid`, `POST /api/push/subscribe`,
`POST /api/push/unsubscribe` (javna plast, privzeto za Basic Auth vrati).
Odpiranje za javno postajo (poslušalci brez poverilnic) poteka prek **dveh**
vzvodov: `web.publicPaths` odpre bralno polovico (`GET /api/push/vapid`),
pisali ruti pa zahtevata izrecni `web.publicWritePaths`, npr.
`"publicWritePaths": ["/api/push/subscribe", "/api/push/unsubscribe"]` —
namensko ločeno od `publicPaths`, ker preširok prefix (npr. `"/api"`) ne sme
anonimno odpreti tudi `POST /api/requests` in lastniških polls akcij;
subscribe je edina anonimna pisalna ruta s hitrostno omejitvijo (30 s/IP)
in stropom naročnin (2000). `config.push.enabled: false` plast pošteno
izklopi: dispatch tick se odregistrira, subscribe odgovori 503, vapid vrne
`enabled: false`. Studio dobi `GET /studio/api/push`
(število naročnin, zadnji poslani termin iz ležerja) in
`POST /studio/api/push/test` (testno obvestilo vsem — edini način, da
lastnik preveri cevovod, preden ga ob oddaji rabi).

V brskalniku: `sw.js` obvlada `push` (JSON {title, body, tag, url}; tag
zamenja zastarelo obvestilo istega termina) in `notificationclick`
(osredotoči obstoječi zavihek). Opt-in pogoj je `userVisibleOnly: true` —
sistem je zgrajen za vidna obvestila, ne tihe.

## Orodja

- `npm run doctor [-- --cron] [--minutes-before=15]`
  — zdravstveni pregled pred terminirano uro: sonde, izstopna koda in
  (z `--cron`) cron vzorec izpeljan iz station.json. Glej razdelek zgoraj.
- `npm run podcast-gen [-- --date --genre --tracks --out]`
  — petminutni Markec Podkast: skripta + načrt epizode v
  `<dataDir>/podcasts/`. Glej razdelek zgoraj.
- `npm run podcast-audio [-- --date --genre --tracks --persona --out]`
  — ISTA epizoda, plus zvok: Piper govor + prave skladbe -> MP3 z
  vgrajenimi poglavji. Glej razdelek zgoraj (P5 #2).
- `npm run themed-shows -- list | brief <tema> | ensure <tema> [minute] | resolve`
  — katalog tematskih oddaj: seznam, predogled izrisanega brifa, pisanje
  brifa na disk in »katera tema je ta teden na vrsti« za vsak special slot.

- `npm run podcast-export -- --dir=<mapa-oddaje> [--audio=<datoteka>] [--title=<t>] [--date=<yyyy-mm-dd>] [--link=<url>] [--out=<mapa>]`
  — P4 #25: RSS 2.0 + itunes feed in show-notes iz produkcirane oddaje
  (podrobno v razdelku o P4 #25).

- `npm run social-export -- --dir=<mapa-oddaje> [--out=<mapa>]`
  — P4 #25: pripravljene socialne objave iz rubrik oddaje (pod 280 znaki,
  z hashtagom).

- `npm run asrun-export -- --from=2026-10-01 --to=2026-10-24 [--out=<mapa>]`
  — P4 #27: izvajalno (as-run) poročilo za licenčno skladnost — CSV +
  povzetek iz `history/aired.jsonl` (podrobno v razdelku o P4 #27).

- `npm run doctor [-- --net] [-- --json]`
  — P4 #31: predvečerna diagnostika — EN ukaz pred terminirano uro, ki
  pove, ali bo oddaja preživela: konfiguracija, podatkovna mapa, govor,
  knjižnica, ledger, korpusi, (z `--net`) viri in šest SUB/WAVE preverjanj
  (icecast, liquidsoap telnet, predvajalne liste, shramba, gostitelj,
  dnevnik napak — opozorila nosijo namig in popravi iz zaprtega nabora
  FIXES). Mrtvi vir je OPOZORILO, ne napaka — točno tako kot v programu
  (podrobno v razdelku o P4 #31).

- `npm run preview-auto-show -- <ime-oddaje> [--duration=<minute>] [--offline]`
  — celoten suhi preizkus producenta: razčleni brief, zgradi vrsto skladb z
  vsemi pravili, izriše skripto, jo preveri in zapiše `script.md` +
  `tracks.json` (iste datoteke, ki jih piše urnik, zato jih lahko takoj
  pošlješ naprej v `direct-show`). `--offline` vsili lokalni vir — brez
  Plexa in brez omrežja.
- `npm run generate-script -- --id=<id>` in `npm run direct-show -- ...`
  — enaka kot prej; pod autoRadio zataknita deterministični poti.
- `npm run generate-filler-playlist` — polnilni seznam prav tako po glasbenem
  viru (Plex ali lokalno).

## Kaj delajo najboljši avtonomni radii (raziskava, P4 #24)

Povzetek raziskave oktobra 2026 (RadioGPT / Futuri AudioAI, Spotify AI DJ,
Aiir, radiocontentpro 2026 vodič, shoutcheap 2026 pregled). Skupne funkcije
vodilnih avtonomnih postaj:

- **sveže lokalne vsebine:** skeniranje novic in trendov (Futuri TopicPulse)
  ter AI DJ, ki komentira vreme, promet in naslovnice;
- **uvajanje skladb + naznanila:** osebnost, ki najavlja pesmi in naznanja,
  kaj sledi kasneje v oddaji (teases);
- **poslušalska interakcija:** zahteve po skladbah prek bota, ankete,
  sporočila social/SMS/WhatsApp na enem zaslonu (Aiir Studio Inbox),
  Alexa/Google spretnosti, push v aplikaciji;
- **multiformatni izvoz:** blog, objave socialnih omrežij, kratki videi in
  podcast iz oddaje (Futuri POST);
- **analitika:** poslušalske heatmape, sentiment, poročila oglaševalcem;
- **otočna avtomatika:** predvajalni logi, licenčna skladnost, now-playing
  push.

Kaj od tega Radio Markec že pokriva (autoRadio, povsem brez modela):

| Funkcija | Markec |
|---|---|
| Lokalne rubrike iz resničnih virov | ARSO vreme (+ poštena offline vrstica, P4 #29), RTV novice + šport (+ poštene offline vrstice, P4 #30), Wikidata obzorje (+ poštena offline vrstica, P4 #30)/glasba (+ lokalni korpus, P4 #28), MusicBrainz zanimivosti |
| Resnični kviz | korpus 40 vprašanj, hecavne predloge (P4 #22/#24) |
| Zanimivosti | korpus + MusicBrainz/sl.wikipedia, skip-not-fail |
| DJ osebnosti + najave | personas, predloge open/intro/recap/close, variantna rotacija |
| Zahteve poslušalcev | requestQueue |
| Analitika poslušanosti | listenerAnalytics |
| Now-playing push | nowPlayingPush |
| Licenčna skladnost (as-run logi) | izvajalno poročilo iz realnega
  predvajalnega ledgerja (P4 #27) |
| Predogled oddaj | imagingPlaylists, preview-auto-show |
| Predvečerna diagnostika | `npm run doctor` — 13 preverjanj (config, mapa, govor, knjižnica, ledger, korpusi, viri + SUB/WAVE: icecast, telnet, liste, shramba, gostitelj, napake); mrtvi vir je opozorilo, nikoli napaka (P4 #31) |

Kandidati iz raziskave so od P4 #25 IMPLEMENTIRANI (glej naslednji razdelek):
teases, podcast izvoz, ankete in social izvoz. Od P4 #27 je pokrita še
licenčna skladnost (izvajalno poročilo) -- ostal je le smart-speaker
spretnost, ki potrebuje zunanjega ponudnika. P4 #28/#29/#30 poleg tega
zapirajo zadnjo luknjo odpornosti: radio preživi mrtev usmerjevalnik s
CELOM programom — vse rubrike ostanejo na zraku (korpusi ali poštene
offline vrstice), živi vremenski segment pa ne podrže več režije.
P4 #31 to pogodbo še pokaže operaterju PRED oddajo: `npm run doctor` je
en ukaz, ki pove, katere noge programa stojijo in katere so na zdravilih.

### P4 #25: raziskava v kodo -- teases, ankete, podcast, social

Štiri ugotovitve raziskave, pretvorjene v delujočo palačo (vse deterministično,
brez modela, s testi):

1. **Naznanila »sledi kasneje« (tease):** takoj po rubrikah, pred prvo
   skladbo, oddaja naznani izvajalca iz zadnje četrtine vrste (obljuba je
   torej resnična po konstrukciji) in -- ko brief odpre kviz položaj -- tudi
   kviz. Slot `tease` / `teaseQuiz`, taksonomija banter. Oddaje s manj kot
   tremi skladbami naznanilo tiho spustijo.
2. **Ankete:** `POST /api/polls` odpre anketo (ena aktivna naenkrat,
   prejšnja se zamrzne v zgodovino), `POST /api/polls/vote` sprejme glas
   (anonimni števec + 30 s omejitev na IP, 429 presežkom),
   `GET /api/polls/active` javno pokaže pošteno stanje,
   `POST /api/polls/close` jo zapre. Rubrika `anketa` v briefu bere
   isto lokalno datoteko: sveža anketa prosi za glasove (`pollRunning`),
   tekoča poroča trenutno stanje brez zmagovalečih trditev (`pollResults`)
   -- in deluje tudi offline, kot kviz.
3. **Podcast izvoz:** `npm run podcast-export -- --dir=<mapa-oddaje>
   [--audio=<datoteka>]` prebere `script.md`/`tracks.json`/`context.json` in
   zapiše `podcast/podcast.xml` (RSS 2.0 + itunes, pravi enclosure z velikostjo
   in MIME-om iz datoteke, ko obstaja) in `podcast/show-notes.md`
   (karta, chapters rundown, rubrike, skladbe). Ista vhoda -> bajtno ista
   izhoda (guid = SHA-1 naslova in datuma).
4. **Social izvoz:** `npm run social-export -- --dir=<mapa-oddaje>`
   pretvori rubrične vrstice oddaje v pripravljene objave
   (`<mapa>/social/01-karta.txt`, vreme, novice, kviz, najave …) -- vsaka
   pod 280 znaki, s `#RadioMarkec`, dolge pa se odrežejo na meji besede.

Obe orodji vrneta žive poti in poglavja; demo izpis je v dokumentaciji
repozitorija.

### P4 #27: izvajalno poročilo (as-run) — licenčna skladnost

Zavodska telesa (SAZAS/ZKP-stil) od radiev zahtevajo poročilo, kaj je DEJANSKO
vetrilo — izvajalec, naslov, začetek, trajanje. Radio Markec to odgovarja z
enim ukazom iz realnega predvajalnega ledgerja `history/aired.jsonl`, ki ga
piše `plex/scrobbleTrack.js` ob točnem startu vsake skladbe (za razliko od
`history/played.jsonl`, ki nastane ob PRODUKCIJI, lahko tedne pred oddajo —
za poročanje ni iskren vir):

```
npm run asrun-export -- --from=2026-10-01 --to=2026-10-24
# -> <dataDir>/asrun/asrun-2026-10-01-2026-10-24.csv          (podroben dnevnik)
# -> <dataDir>/asrun/asrun-2026-10-01-2026-10-24-povzetek.txt (skupaj + top izvajalci)
```

- **CSV** je podpičkast z RFC 4180 navedki (slovenski Excel ga odpre brez
  nastavljanja): stolpci `datum;ura;izvajalec;naslov;album;trajanje_s;oddaja`.
  Časovni žig je tisti, kateremu je ledger že veroval — prvi 10 znakov `playedAt`
  je postajina lokalni datum, brez ponovne časovne cone.
- **Povzetek** pove skupno število predvajanj, različnih del in izvajalcev ter
  lestvico največ predvajanj (porazdelitev po izvajalcih — kar skladnostne
  službe pravzaprav iščejo; pri neodločenih odloča abeceda, zato je isti
  vhod vedno bajtno ista datoteka).
- **Skip-not-fail**: manjkajoči ledger (sveža namestitev) pomeni veljavno
  prazno poročilo, pokvarjena vrstica se preskoči in prešteje, manjkajoči
  podatki ostanejo prazne celice — poročilo ne sme nikoli potrebovati
  ročnega popravljanja, da sploh nastane.
- Okno je inkluzivno na obeh koncih (`--from`/`--to` ali privzeto današnji
  dan); izhodna mapa se preglasi z `--out`.

### P4 #28: lokalni korpus "na današnji dan v glasbi" (rezerva za obzorjeGlasba)

Rubrika `glasba` ("Na današnji dan v glasbi") je do P4 #28 živela izključno na
Wikidatinih SPARQL poizvedbah -- brez omrežja (mrtev usmerjevalnik, timeout,
prazni datum) je bila tiho spuščena, čeprav je prav ta rubrika najbolj
"radijska" od vseh. Od P4 #28 za njo stoji **lokalni korpus**
(`src/auto/onThisDayFacts.js`): 56 ročno kuriranih, sicer povsem dokumentiranih
glasbenih rojstev in smrti prek 47 dni koledarja (od Louisa Armstronga do
Slavka Avsenika, z Vlada Kreslinom), v ISTI obliki dogodka, ki jo vrača
Wikidata (`year`/`name`/`sex`/`kind`) -- izris skozi iste predloge, brez
napak v spolnih končavah.

- **Primarnost ohranjena:** Wikidata ostane prvi vir; korpus stopi samo, ko
  je mrežni odgovor nedosegljiv ali prazen. Ista dnevna deterministika:
  isti datum + isto seme = isti dogodki v istem vrstnem redu (FNV-1a,
  kot kviz).
- **Offline branch:** v `--offline` načinu se rubrika zdaj ne umakne več,
  ampak pokaže korpus -- kot kviz, anketa in poslušalci. Brez dejstev za
  datum korpus vrne `null` in segment tiho spade (skip-not-fail).
- **Tone pass:** bazena `obzorje` in `obzorjeGlasba` imata poleg osnovnega
  stavka še po eno hecavno varianto na kindKey (rojstva igriva, smrti
  tolažilno -- "plošče pa od takrat molčijo le, ko jih mi izklopimo").

### P4 #29: vreme brez omrežja — poštena rezerva na vseh legah

Vremenska rubrika je bila zadnja, ki ob mrtem usmerjevalniku ni imela
rezerve: ARSO odgovori → `weatherNow`; ARSO odpove → segment tiho izgine —
čeprav handoff na dveh tretjinah oddaje ("Poglejmo še, kakšno vreme nas
čaka ...") obljubi vreme, ki nato ne pride. Hujše pa: živi vremenski segment
se rešuje V REŽIJI (`directShow()` čaka `resolveLiveLine()` brez ponovnega
poskusa), tako da je odpoved Open-Meteo točno v trenutku režije pomenila
PADLO CELO oddaje — brez `playlist.m3u`, dead air do naslednje terminirane
oddaje. P4 #29 zapre obe luknji s tremi premiki, vse po istem dogovoru kot
korpus #28:

- **Rubrika:** ko ARSO ni dosegljiv (offline način, mrtev router, timeout,
  manjkajoča postaja), gre na zrak **poštena offline vrstica** — nova
  predloga `weatherOffline` ("Vreme: postaja Ljubljana se je danes poslala
  na dopust -- uradnih podatkov ni, priporočamo pa brezplačno aplikacijo,
  ki ji rečemo okno."). Zdrav ARSO še vedno zmaguje (`weatherNow`),
  nadomestna vrstica pa ima zapisana PRAVILA POŠTENOSTI, ki jih varujejo
  testi: **brez številk, brez stopinj, brez besed, ki bi jih WMO slovar
  lahko izgovoril kot podatke** — vremensko poročilo brez številk ne more
  pretvarjati, da je podatek. Šala JE iskrenost: vrstica glasno pove, da
  podatkov ni, in pokaže na edini zanesljivi senzor, ki ga ima poslušalec
  (okno).
- **Živi segment:** `auto/liveLines.js` ujame odpoved Open-Meteo in rešuje
  `live:weatherOffline` ("Je {time} -- vremenska povezava je na dopustu,
  okna pa delujejo brez omejitev."). Režija torej NE PADA več; handoffova
  obljuba ostane izpolnjena. Lokalna ura je edini podatek, ki ga imamo —
  pogoj in temperatura se ne izmislijo.
- **Izvozi:** podcast show-notes in social izvoz poznata nov slot
  (`weatherOffline`), tako da poštena vrstica pride tudi v oba izvoda.

Deterministika neuspeha je enaka deterministiki podatkov: isti dan + isto
seme = ista offline vrstica (FNV-1a kot povsod), tako ostanejo prepisi
reproducirljivi in zvok predpomnljiv. Testi: 415 → 435
(`test/weatherOffline.test.mjs`, 20 — vključno z varovalkami poštenosti, ki
prepovedujejo številke in vremenske besede v vseh variantah obeh bazenov,
ter živim testom, ki dokazuje, da mrtev Open-Meteo NE vrže več napake).

### P4 #30: novice, šport in obzorje — poštene offline vrstice

Po #29 je ostala zadnja trojka rubrik, ki je ob mrtem usmerjevalniku
preprosto izginila: `novice` in `šport` (RTV RSS) ter net-polovica
`obzorja` (Wikidata). P4 #30 zapre tudi to trojko, po istem dogovoru kot
vreme — z enim pomembnim zaostrenim: **izmišljanje naslovnic je
NEETIČNO**, zato nadomestna vrstica ne more vsebovati niti približka
novičarske vsebine. Pravila poštenosti (varujejo testi v
`test/honestOffline.test.mjs`) so STROŽJA kot pri vremenu:

- **nič izmišljenih vsebin:** brez številk (naslovni servis brez številk ne
  more pretvarjati, da ima naslovnice), brez imen ljudi, ekip, rezultatov
  in datumov, brez obtoževanja virov na zraku (nobenega "RTV"/"Wikidata" —
  bazeni so viru-generični),
- **oblika rubrike se ohranja:** vsaka varianta `newsOffline` se odpira z
  "Novice:", `sportOffline` s "Športne novice:", `obzorjeOffline` s "Na
  današnji dan" — enako kot podatkovne predloge, tako da seštevek zveni
  kot rubrika, ne kot napaka,
- **šala JE iskrenost:** vrstica glasno pove, da danes naslovnic ni, in
  odda mikrofon glasbi ("edini zanesljiv rezultat današnjega dne je, da
  glasba vodi z ena nič").

Zdravi viri še vedno zmagujejo (RTV naslovnice → `newsHeadlines`/
`sportHeadlines`, Wikidata dogodki → `obzorje`); pri `obzorju` vrstica
pokrije tudi pošteno PRAZEN odgovor (datum brez slovensko označenih oseb —
arhiv ni povedal ničesar, kar bi lahko brali na zraku, in to tudi ne
pretvarjamo). Rubrika ostane opt-in prek briefa: brez `novice`/
`šport`/`obzorje` v briefu tudi poštena vrstica ne zazveni.

- **Izvozi:** podcast show-notes (poglavja "Novice -- poštena vrstica" …) in
  social izvoz poznajo nove slote, tako da poštene vrstice pridejo v oba
  izvoda. V clips načinu so novi sloti skladno z dogovorom preskočeni,
  dokler operator ne posname svojega klipa z istim imenom.
- **Deterministika:** isti dan + isto seme = ista vrstica (FNV-1a kot
  povsod). Testi: 435 → 454 (`test/honestOffline.test.mjs`, 19 — varovalke
  poštenosti, obe zbirateljski veji, izris, scriptBuilder in taksonomija).

### P4 #31: predvečerna diagnostika (`npm run doctor`) — krona odpornostnega loka

Odpornostni lok P4 #28–#30 je naredil program, ki preživi mrtev
usmerjevalnik — ampak do #31 ni obstajal način, da to ugotoviš vnaprej,
brez čakanja prve režije. `npm run doctor` je en ukaz, ki operaterju
pred terminirano uro pove, ali bo oddaja preživela in kaj je na
zdravilih. Trinajst preverjanj v stalnem (za testi zamrznjenem) vrstnem
redu: konfiguracija, podatkovna mapa, govor (TTS), glasbena knjižnica,
predvajalni ledger, korpusi, (z `--net`) dostopnost virov ter šest
preverjanj, ukradenih iz SUB/WAVE (4-c): icecast (oddajnik), liquidsoap
(telnet), predvajalne liste, shramba (arhiv/disk), gostitelj (CPU/spomin)
in dnevnik napak (24 h).

Dogovori, ki jih diagnostika varuje — enaki kot program sama:

- **skip-not-fail velja tudi za diagnostiko:** nobeno preverjanje ne sme
  pasti; če se kljub temu sesuje, ga varovalka zamenja z opozorilom
  ("preverjanje se je sesulo: …"). Doctor, ki pade, bi operaterja pustil
  brez odgovora prav takrat, ko ga potrebuje.
- **mrtvi vir = OPOZORILO, NIKOLI napaka** (testno pinano): to je točno
  pogodba P4 #28–#30 — rubrika poje pošteno vrstico, radio igra dalje.
  Kakršna koli HTTP odgovor (tudi 4xx/5xx) šteje kot dosegljiv vir:
  merimo dostopnost, ne pravilnost. Diagnostika, ki bi umirala ob
  mrtvem routerju, bi lagala o programu.
- **iskrenost o TTS-u:** manjkajoč piper glas (ključna oblika) je
  opozorilo z resnico ("naloži jo ob prvi sintezi — enkrat,
  HuggingFace"), edge pa je označen kot spletna storitev, ki se
  preverja v režiji — ne pretvarjamo se, da znamo preveriti nepreverljivo.
- **korpusi so hrbtenica in so del kode:** njihove spodnje meje (kviz 40,
  glasba 40 dejstev/40 dni, zanimivosti 20) zrcalijo integritetne teste;
  če kdo skrči hrbtenico, doctor to pokrika PRED oddajo. Ker so del
  kode, korpusi ostanejo OK tudi ob popolnoma zlomljenem config.json.
- **fail je redka stvar:** NAPAKA je samo tisto, ob čemer program RES ne
  more sestaviti oddaje — zlomljen config.json, dataDir, ki kaže na
  datoteko, nič skladb v `local` načinu, poškodovani korpusi. Vse ostalo
  je opozorilo ali preskok. Exit code: 1 le ob NAPAKI (zanesljiv za
  cron/monitoring; `--json` vrne strojni izpis).

Ledger se preverja z ISTIM branjem kot izvajalno poročilo (P4 #27
`readAiredFile`) — bajtno ista štetja, ista toleranca. Pokvarjene
vrstice so opozorilo (izgubljeni podatki za licenčno poročilo), tako
kot ledger brez vnosa starejšega od 7 dni (morda ne piše
`scrobbleTrack`).

### Paket B1 (Val 21): zaključna napoved naslednje oddaje

Zadnja vrstica vsake oddaje je zdaj tisto, kar pravi radio počne samo od
sebe: **napoved, kaj sledi** — »Takoj za mano pa danes ob 20:00 — oddaja
Večerni maraton z voditeljem Elena. Ostani z nami!«, nato pa še poslovilni
pozdrav. Graditelja skript (`scriptBuilder.js` za avto pot,
`boundaryWalk.js` za AI pot) odložita živi segment `kind: nextShow` takoj
pred zaključni `dj` segment; ker sta govorni sosedi, ju režiser zlije v eno datoteko
(`director/index.js` flushPendingSpeech) — napoved prva, poslovilje drugo,
brez prehoda med njima.

**Zakaj živi segment in ne vrstica v skripti:** skripta in dj-glas se
predpomnlita PO oddaji/datumu, ponovitev istega dne pa ju DELEŽI — v času
pisanja skripte torej ne vem, katera ponovitev bo zadnja, in bi »naslednja
oddaja« na ponovitvi imenovala oddajo, ki je že bila na zraku. Zato se
podatki (ime, voditelj, ura, dnevna beseda) razrešijo šele OB REŽIJI —
približno 15 minut pred etrom (`directLeadTimeMinutes`) — iz `station.json`
ovega urnika prek `nextOccurrence`, ki pravilno prečka tudi temne dneve.
Skupen razreševalec je `resolveNextShowValues` (`auto/liveLines.js`);
obe poti (avto predloge + AI dejstva) ga uvažata iz istega vira, zato o
tem, kdo je naslednji, nikoli ne moreta dati različnega odgovora. Dnevna beseda
(»danes«/»jutri«/»v sredo«) se računa glede na NOMINALNI KONEC trenutne
oddaje — oddaja, ki gre čez polnoč, mora jutranjo oddajo napovedati z
»danes«, ker tako sliši poslušalec, ko vrstica gre v eter.

**Iskrena obramba pred zastarelostjo:** urnik, spremenjen v tistih ~15
minutah med režijo in etrom, pusti napoved odveč — a to je strogo bolje
kot pri vsaki drugi govorjeni vrstici, ki nastane ure/dni prej. Nihče ne
zmaga proti urejevalniku urnika ob 19:52.

**Lestvica degradacije** (nikoli izjema v režijo, P4 #29 lekcija):

1. Naslednja oddaja obstaja → bazen `live.nextShow.withHost` (ime, voditelj,
   dan, ura) ali `noHost` (oddaja brez voditelja nikoli ne dobi obvislega
   »z voditeljem«).
2. Razreševanje odpove (brez identitete pojavitve, timeKey po urejanju
   urnika ni več v njem, v naslednjih 7 dneh ni nič programiranega,
   neberljiv station.json) → poštena offline vrstica `live.nextShowOffline`
   (»urnik trenutno molči …«), ki si ne izmisli NE dneva NE ure NE imena —
   brez števk, po vzorcu `weatherOffline`.

Seme izbire različice je razrešeni DAN+URA naslednje oddaje, ne stenska ura —
isto stanje urnika = ista vrstica = reproducirljivi prepisi (vreme ima
namerno ostalo stensko-urno seme, ker je njegov podatek prav stenska ura).

**Meja načinov clips/pregenerated:** živi segmenti so tam po konstrukciji
preskočeni — ti načini iščejo datoteke po imenu slota (`resolveClipPath`,
preslikani sloti za pregenerated pokrivajo le open/close/handoff), posnet
klip pa nikoli ne more vedeti, kaj je naslednje ob režiji. Enako kot živo
vreme danes: napoved preprosto utihne, poslovilni pozdrav pa povede naprej.
V načinu `none` seveda utihne ves govor — besedilo ostane v `script.md` in
`transcript.json`.

### Paket C (Val 22): datumsko-vezani dnevi in ponovitve

Urnik je bil od začetka TEDENSKA predloga: božičnega zajtrka ni bilo mogoče
izraziti, enkratna oddaja ob prireditvi pa je zahtevala ročno prestavljanje
cele predloge. Paket C zapre obe vrzeli iz raziskave 19
(docs/programming-research.md §5) — z dvema mehanizmoma, ki živita v isti
datoteki (`station.json`), isti vzdrževalni disciplini (atomske operacije,
fail-open bralci, poštena degradacija) in istem urejevalnem površju (studio
Spored → zavihek Datumi; MCP in ročno urejanje sta enakovredni poti).

#### C1: Datumsko-vezani dnevi (`schedule.dates`)

`schedule.dates["2026-12-25"] = [ ... ]` **nadomesti celoten dan**: tedenska
predloga za ta datum NE velja in se z prenosom NE združuje. Precedens je
en sam izraz — `dates[datum] ?? predloga[teden-dneva]` — izveden v eni
funkciji (`scheduleUtil.effectiveDayLineup`), ki jo delijo vsi sprehajalci
po urniku (razporejevalnik, `now-playing`, mreža na javni strani, napoved
naslednje oddaje), zato se ti o tem, kaj je tisti dan na zraku, NIKOLI ne
morejo raziti. **Prazna lestvica `[]` je namenja prazen dan**: filler in
nujni sloj ga pokrijeta natanko tako, kot pokrijeta vsak dan brez urnika,
javna mreža pa izriše »Brez oddaj«.

- **Neveljavni ključi se ob branju preskočijo** (fail-open po ključu:
  tipkarske napake in ne-tabelične vrednosti ne sesujejo vsakega
  `/api/schedule` polla); pisanje je strožje — ključ mora biti PRAVI
  koledarski datum (`2026-13-45` gre skozi obliko, ne skozi preverjanje
  povratne pretvorbe) in vsak vnos veljaven, sicer celoten ZAVRNJEN.
- **Doctorjev cron vzorec se izpelje ŠE VEDNO samo iz tedenske predloge**
  (`cronVzorec.js` ignorira ne-tedenske ključe) — datumski prenosi ne
  motijo terminiranih ur.
- **Urejanje bloka `dates` sredi dneva sproži `scheduleWatch` invalidacijo
  NATANČNO kot vsak drugi poseg v `station.json`**: produkcija, ki še ni
  šla v eter znotraj obzorja, se pobriše; oddaja, ki je ravno na zraku, je
  zaščitena.
- Studio UI je NAMENJEMA glasno: »Nadomesti celoten dan — tedenska
  predloga za ta datum ne velja.« Shrani pomeni CEL POPOLN dan (PUT),
  nikoli združevanje; prazen seznam je vidna, poimenovana odločitev
  (»prazen dan — samo filler«), ne tiho presenečenje.

#### C2: Replay/ponovitve (`type: "replay"`)

Vsak vnos v urniku (tedenski ali datumski) je lahko ponovitev obstoječe
epizode:

```
{ "type": "replay", "sourceDate": "2026-12-20", "sourceTimeKey": "08-00", ... }
```

`sourceDate` je dan, ko je epizoda PRVIČ šla v eter; `sourceTimeKey`
(HH-MM) je neobvezen — izpuščen pomeni »prva pojavitev te oddaje na
sourceDate«. Vir ne sme biti v prihodnosti (validacija ob pisanju); sme pa
biti isti dan — večernja ponovitev jutranje epizode je zakonita. Polje
`"type": "normal"` ali njegova odsotnost je navaden vnos;
`normalizeReplayFields` poskrbi, da odmrli replay-podatki nikoli ne ostanejo
prilepljeni na navadne vnose.

Ob času neposredne priprave (~15 minut pred etrom,
`directLeadTimeMinutes`) razporejevalnik replay **materializira**: KOPIRA
vir-pojavitvino `playlist.m3u` in `context.json` v svoj imenik pojavitve
(kopija, ne symlink, ne živo razreševanje — fillerjeva detekcija v
`scrobbleTrack.js` prebere playlist iz imenika pojavitve in ponovljene
skladbe morajo pristati v svojem lastnem vrtilnem dnevniku). Nove
produkcije ni — skripta se ne gradi znova, zato **statistika prvega etra
preživi**: `played.jsonl` ostane nedotaknjen, vnosi v `aired.jsonl` pa
dobijo dodatno zastavico `replay: true`.

Manjkajoč ali potekel vir je **pošten no-op**: filler pokrije slot, nič se
ne zgenerira in ne javi kot napaka. Veljavnostno okno ponovitve je
`cleanup.retentionDays` (privzeto 7 dni) — po tem dnevu čiščenje pobriše
vir in ponovitev čaka usodo vsakega manjkajočega vira.

Operaterski reševalnik (isti CLI vzorec kot `promoProducer`/`formatClock`):
`node src/scheduler/replayMaterializer.js <teden-dan> <id-oddaje> <datum> <čas>`
ročno materializira replay vnos — npr. ko je direct tick zamudil — z izhodno
kodo 0 tudi ob pošteni nič-opi (le dejansko zlomljena namestitev postavi
izhodno kodo 1).

**Ograja o svežini (ista življenjska doba kot B1, le dlje):** živi segmenti
(vreme, čas, napoved naslednje oddaje) so bili sintetizirani ob ETERSKEM
času VIRA in so zvarjeni v govorne datoteke — ponovitev torej izgovori
tudi zaključno napoved, ki imenuje oddajo, ki je sledila IZVORNEMU
predvajanju. To je natanko razred »iskrene obrambe pred zastarelostjo« iz
razdelka Paket B1 zgoraj (urejevalnik urnika v zadnjih minutah pred etrom
premaga vsako predprodukcijo); replay živi eno retencijo dni dlje, princip
je isti — vsebina je bila resnična ob času, ko je nastala.

### Paket D (Val 23): formatna ura — postelje, ki jih postaja proizvaja sama

Profesionalna postaja ne izbira samo glasbe — vsaka ura ima PREDLOGO:
vreme ob `:15`/`:45`, napoved naslednje oddaje N minut pred preklopom.
Radio Markec je ves ta mehanizem že imel (vrsta `beds` + sidechain ducker
v `radio.liq`, `beds.push` prek telneta), manjkala je le "samodejna
produkcija → postelja", ki jo je docs/imaging-layer.md nekoč imenoval za
ločeno prihodnjo odločitev. Paket D (raziskava 19 §5) je ta odločitev sprejel:
nov job `scheduler/formatClock.js` ob pravih minutah **producira klip**
(Open-Meteo trenutne razmere / kratki iz urnika, predloge `bedWeather` /
`bedNextShow`, Edge TTS, ebur128 izmera zapečena v bajte — promosova
disciplino dobesedno) in ga ob **točno določeni minuti** potisne v vrsto
postelj. Glasba se utiša na 20 % samo med govorom, poslušalec pa sliši
formatno uro, ne meja skladb.

- **Časovni model** (push/dispatch vzorec, prestavljen iz minut v sekunde):
  tik vsake `tickIntervalMinutes` (privzeto 0,1 = 6 s, frakcijske kadenice
  so zakonite — `nowPlayingCheckIntervalMinutes` že teče 0,1) izračuna
  `fireTime` vsakega dogodka. Dogodek se sproži na prvem tiku znotraj
  `[fireTime, fireTime + 45 s)`; ključ v `history/beds-fired.jsonl`
  (datum@čas@kaj, JSONL po vzoru `push/sent.jsonl`) poskrbi, da restart
  sredi okna ne pove istega dvakrat, prostor, ki se je okno zaprlo, pa
  se iskreno preskoči — vremensko poročilo ob `:16` bi lagalo o uri.
- **Produkcija TEČE PRED minuto** (`produceLeadMinutes`, privzeto 4):
  sprožitev je potisk lokalne datoteke (milisekunde), nikoli omrežni klic
  ob etru. Deterministično ime (`weather_<datum>_<HH-MM>.mp3`,
  `nextshow_<id>_<datum>_<HH-MM>.mp3` v `dataDir/beds/`) JE varovalka pred
  ponovnim delom — obstoječa datoteka pomeni preskok.
- **Dan v napovedi naslednje oddaje je vezan na ČAS SPROŽITVE**, ne na čas
  produkcije (`slovenianDayLabel` proti `fireTime`): postelja, ki sproži
  ob 23:57 za oddajo ob 00:02, pravi »jutri« — to sliši poslušalec.
- **Ograja o svežosti (ista življenjska doba kot B1):** urnik, spremenjen
  v zadnjih minutah pred sprožitvijo, pusti napoved odveč; produkcija teče
  minute pred etrom, natanko kot vsa predprodukcija postaje.
- **Nastavitve** (`config.imaging.beds`, OPT-IN — plast, ki GOVORI na etru,
  se na obstoječi namestitvi nikoli ne prikaže nepovabljena):

| Ključ | Privzeto | Pomen |
|---|---|---|
| `enabled` | `false` | brez bloka = izklopljeno, job se sploh ne registrira |
| `tickIntervalMinutes` | `0.1` | kadence tika (frakcijske vrednosti zakonite) |
| `weatherMinutes` | `[15, 45]` | minute znamenj vremena; `[]` = vreme izklopljeno |
| `weatherDaypart` | *(ni v config.example.json)* | okno vremenskih postelj `{from,to}` (HH:MM, od vključno / do izključno, brez polnočnega ovijanja — clockwheel konvencija, skupen parser `parseWheelTime`); brez okna = ves dan; nextshow napovedi niso okenske (Val 25) |
| `produceLeadMinutes` | `4` | koliko minut pred sprožitvijo se klip producira |
| `nextShowLeadMinutes` | `5` | koliko minut pred začetkom oddaje gre napoved; `0` = izklopljeno |
| `clipRetentionHours` | `2` | pometanje odmrlih klipov; `0` = večno |
| `persona` | *(ni v config.example.json)* | ime osebe (`autoRadio.voice.personas`) — izpuščeno namenoma, globalni Edge glas je zdrava privzetost (promosova kaskada) |

- **Pometanje pobriše SAMO generirana imena** (`weather_*`/`nextshow_*` z
  datumom in uro): operaterjeva datoteka v `beds/` kateregakoli drugega
  imena je za job nedotakljiva za vedno (nosilec varovanke, promosova
  pravila dobesedno). `beds/` NI m3u plast — datoteka, odvržena vanj, se
  sama od sebe ne predvaja; operaterjeve postelje se potiskajo ročno
  (`node src/liquidsoap/bedQueue.js push <datoteka>`).
- **Dodatek (Val 25) — nočno okno + ročni sprož.** Noč profesionalne
  postaje je avtomatizirano, vremensko tiho področje (raziskava §2.1);
  `weatherDaypart` okno to izraža z eno vrstico (`{"from":"06:00",
  "to":"23:00"}` ali do `"24:00"`), prazno/manjkajoče/šmetano pa
  pomeni ves dan (obstoječe namestitve se ne spremenijo). Ročni sprož —
  `node src/scheduler/formatClock.js trigger weather|nextshow [showId]`
  ali MCP `beds_trigger` — proizvede SVEŽ klip ob trenutku klica in ga
  takoj potisne; upošteva LE `imaging.beds.enabled` (urnik in okno sta
  oblika samodejne ure, ročni klic je preglasitev), ne piše ključa v
  knjigo (knjiga razdružuje samodejne slote), zavrnitve pa so napake, ne
  izidi (CLI izstop ≠ 0, MCP isError). Imena `weather_manual_*` /
  `nextshow_manual_*` pometanje pobriše kot vsa generirana.
- **Dnevna varnostna kopija** pokriva `history/beds-fired.jsonl` (razred
  `push/sent.jsonl`); sami klipi so izpeljani (vreme vir + urnik) in se NE
  kopirajo. V tem valu je backup dobil tudi `imaging/promos/` (vrzel iz
  Val 21: operaterjevi promo klipi so bili izven kopije).
- **Namestitve z namestniško predlogo** (`install.sh`) nimajo vrste
  `beds` v `radio.liq` — prižiganje `imaging.beds.enabled` tam pomeni
  poštene zavrnitve potiska v dnevniku (in nič na etru); plast živi v
  referenčnem `liquidsoap/radio.liq` (isto opozorilo kot promosi,
  DEPLOYMENT_GUIDE.md).
- `radio.liq` SE NI SPREMENIL niti za en znak — celoten Paket D je Node
  nad obstoječim dukerjem. Testi: `test/formatClock.test.mjs` (64;
  vrata, nastavitvene odločitve, slotna aritmetika, sprožitve z enojnim
  poskusom, produkcija z izmero/padci, sočasnost, pometanje, knjiga,
  predloge + prepis lastnika; Val 25 dodaja blok K okna `weatherDaypart`
  (F2 padci, meje minute znamenja, zanka 05:58→06:15, nextshow neokenska,
  združljivost brez okna), blok L ročnega sproža `triggerBed` (vrata,
  vrste, svež fetch, preglasitev urnika in okna, `showId`, »jutri«,
  zavrnitve potiska, izmera, brez ključa v knjigi) in blok M CLI odpreme
  (spawn: izstop 0/1/1)).

### Nadgradnja iz SUB/WAVE (4-c): Finding model + šest novih preverjanj

SUB/WAVE-ov doktorjev poroča najdbe (Finding): `{label, status, detail,
hint, fix}` — `hint` pove, KJE poglej, `fix` (`{id, label}` iz ZAPRTEGA
nabora `FIXES`) pa KAJ stori. To strukturo smo ukradli brez AI: opozorila
novih preverjanj jo nosijo (izpiše se `    namig: …` / `    popravi: …`
pod vrstico, `--json` pa jo nespremenjeno nese naprej), vsi obstoječi
rezultati pa ostanejo bajtno enaki. Nabor popravkov je zaprt prav zato,
ker se ga da pripeti na gumb: `check-icecast`, `restart-liquidsoap`,
`regenerate-filler`, `prune-archives`, `free-disk`, `inspect-logs`
(gostitelj NIMA popravka — pritisk na škatlo se ne reši z enim klikom in
raje je to pošteno priznati kot opozorilo brez ukrepa).

Šest novih preverjanj, po vrstnem redu za viri:

1. **icecast (oddajnik):** sonda na
   `http://<sourceHost>:<port>/status-json.xsl` (ista izpeljava URL kot
   štetje poslušalcev). Vsak HTTP odgovor (tudi 4xx/5xx) = OK — merimo
   dostopnost, ne pravilnost, enako kot pri virih. Padec = »poslušalci
   trenutno ne slišijo ničesar … program igra dalje« → opozorilo +
   `check-icecast`. Manjkajoč `icecast` blok v configu → pošten preskok.
   Sonda NE gre pod `--net`: oddajnik je LAN storitev postaje same.
2. **liquidsoap (telnet):** ukaz `uptime` (Liquidsoapov vgrajen strežniški
   ukaz, ne radijski) čez pravi telnet odjemalec. Živ odgovor → OK z
   izrezkom odgovora; `ERROR:`/prazen/zavržen → opozorilo +
   `restart-liquidsoap`. Odjemalec se uvaža dinamično ŠELE, ko je config
   prebrano (telnetClient potegne config na vrhu — zlomljen config.json
   ne sme seseti diagnostike).
3. **predvajalne liste:** štetje ne-praznih, ne-komentar vrstic
   `now_playing.m3u` in `filler.m3u`. Obe prazni/manjkajoči = »program bi
   padel na nujni seznam« — emergency.m3u je ZADNJA rezerva, zato
   opozorilo, nikoli napaka + `regenerate-filler` (namig kaže na
   `npm run update-now-playing` / `generate-filler-playlist`).
4. **shramba (arhiv/disk):** (i) hoja po urnem arhivu z ISTIMI pravili kot
   studio Arhiv (dan `YYYY-MM-DD`, ura `HH-00.mp3`): čez 20 GB je
   zadrževanje milo napihnjeno → `prune-archives`; arhiv izklopljen
   (`archive.enabled !== true`, strogo kot streamsLiqWriter) → del (i) je
   v detailu pošteno preskočen. (ii) `fs.statfs` na dataDir (prosto =
   `bavail × bsize`, kar je na voljo procesu): pod 2 GB → `free-disk`;
   kjer statfs ni na voljo ali pade, podatek o prostoru preprosto IZPUSTIMO
   — ni lažnega števila.
5. **gostitelj (CPU/spomin):** `/proc/loadavg` (load1) in
   `/proc/meminfo` (MemAvailable/MemTotal). load1 nad 2×jedri = produkcija
   (TTS, ffmpeg) lahko zamudi; pomnilnik pod 10 % = sinteza začenja
   odpovedovati. Brez popravka v FIXES. `/proc` neberljiv (gostitelj ni
   Linux) → preskok z opombo.
6. **dnevnik napak (24 h):** vrstice z `ERROR` (dobesedno) v AKTIVNIH
   `.log` datotekah — rotirana `.log.1` se ne bere, da ena napaka ne šteje
   dvakrat — katerih `[ISO]` žig pade v zadnjih 24 h. Čez 20 = »nekaj se
   vrti v zanki« → `inspect-logs`; 1–20 = OK s poštenim štetjem; vrstice z
   nerazumljivim žigom se ne štejejo (konzervativno).

Vseh šest teče pod isto varovalko `safe()` in istim pokrovom configa:
zlomljen config.json = »preskočeno -- config ni berljiv« pri vseh šestih,
ne lažna sonda. Izpeljava poti/nizov iz configa (`nowPlayingPath`,
`fillerPath`, `archiveRoot`, `logsDir`, `icecastUrl`, `telnetPort`,
`archiveEnabled`) živi v CLI-ju — doctor.js ostane brez configa (tudi
branje /proc, telnet, statfs in fetch so injicirani šivi, kar je edini
način, da izpis ostane determinističen).

- **Odpornost doctorja samega:** CLI dinamično uvaža config v
  try/catch — zlomljen config.json je NAPAKA v izpisu, ne crash pred
  prvo vrstico. Slovensko števanje (1 vnos, 2 vnosa, 5 vnosov) skrbi
  `slPlural`.
- **Deterministika:** isti inputi → bajtno isti izpis (fiksni vrstni
  red, statična razlaga; test potrjuje z dvema tekomema). Testi:
  `test/doctor.test.mjs` 47 → 79 v tem valu (79 preverjeno tudi danes;
  celotna suite raste z vsakim valom, zato tu ni njenega števila) — vseh
  trinajst preverjanj, obeh vej config/ne-config, varovalka poštenosti za
  vire, Finding model (FIXES zaprt nabor, hint/fix samo na opozorilih),
  meje 20 GB / 2 GB / 2×jedri / 10 % na BAJT točno, `.log.1` izpuščen,
  determinizem, exit-kodna preslikava, cron vzorec). Demo:
  `node scripts/demo_doctor.mjs` (zdrav + pokvarjen peskovnik + zlomljen
  config).

## Zapisi, ki ostajajo odprti (PoC)

- `artistList` teme ostajajo ročne (brez modela ni razširjanja konceptov).
- `singleAlbum` v lokalnem načinu ni podprt (Plex albumni metadata).
- Popolna determiniranost zaporedja je zavestno zmehčana: izbira uporablja
  naključni miks znotraj pravil (kot prej), le različice predlog in posnetkov
  so povsem odločene z zgoščevalom.

## Prehodi: naravni šivi med pesmimi in govorom (Val 28)

"Robotski prehodi" so bili druga polovica direktive iz vala 27 — ta razdelek
opisuje, kaj ju je odprlo. Vsa dela so deterministična (nič AI modelov) in
izhajajo iz IZMEROV (avtocuejev indeks glave/repa vsakega sleda).

### Kaj je slišno že na današnjem Liquidsoapu 2.2.4

- **Izmerjen fade-in namesto fiksnega 2 s** (B1): avtocuejeva nova GLAVNA
  prečka (`analyzeHead`, prvih 20 s vsakega sleda) izmeri, kako pesem
  ZAČNE. Postopna (gradualna) introska zgradba dobi 2,5–4,0 s fade-in
  (izmerjeni vzpon JE platno), hladen napad 0,5 s omehčitve, srednji pas
  in neizmerjeni sledi pa obdržijo star privzetek 2 s — neizpreskanjena
  knjižnica se obnaša bajtno enako kot prej. `radio.liq` fade.in ovojnice
  so NEVRATNE, zato je to slišno takoj.
- **Bed lead-out** (B2): postelje formatne ure so imele 0,8 s lead-in, a
  NIČ lead-out — zadnja beseda je padla v silo. Vsak izmerjen klip zdaj
  dobi 0,5 s zapečene izumrtve, ki se sklada z duckerjevim izpustom —
  glasba se dvigne POD pojemenjujoč rep, ne pa s klifom.
- **Utiha med napovedjo in poslavljanjem** (B5): zaključna "kaj sledi"
  napoved in poslavljanje sta bila spojena v en dih. Med njima je zdaj
  0,7 s prave tišine (`director/speechRuns.js`) — napoved pristane.
- **Glasnost govora poravnana z glasbo** (B4): DJ govor je bil edina zvočna
  ploskev brez poravnave glasnosti (Edge je redno 4–8 LUFS pod glasbo).
  Vsak govorni tekel dobi EN ebur128 prečko in zapečeno korekcijo na cilj
  `autocue.targetLufs` (privzeto −16); `djDrops.gain` ostane kot okus
  (1,3 = +2,3 dB nad glasbo). Neizmerjen/neuspešen tekel gre na eter, kot
  je bil — govor nikoli ne izgine zaradi merjenja.
- **Raznolikost govornih mej** (C1): vsaka meja med pesmimi ni več obvezni
  intro+recap par. `producer/fenceposts.js` deterministično (seme =
  oddaja+datum) pusti ~1 od 4 mej tiho (dve pesmi hrbet-ob-hrbtu, nikoli
  sosednji, kviz in vremenski prehod sta vedno zaščitena), oddaje z ≥ 6
  pesmimi dobijo EN tease v drugi polovici (`teaseMid` bazen). Trivia P4 #17
  kadenca ni gatingana — dejstvo o izvajalcu naravnost v pesem je sam
  sebi prelom.
- **Promosi ne reklamirajo oddaje, ki je ravno na etru** (C3): okno promosev
  je strogo prihodnje; klip oddaje, ki je medtem začela, ob naslednjem tiku
  (≤ 30 min) zapusti bazen. Iskrena meja: v tem oknu lahko zastareli promo
  še enkrat odleti (randomize brez spomina) — dokumentirano in sprejeto.
- **Bazen ID-jev ne strada več** (Val 31): `loop=false` na `id_source` je
  bazen izčrpal po N klipih in NIČ ga več ni napolnilo (prepis m3u se ob
  byte-identični vsebini preskoči — stara trditev »prepis nafila bazen« je
  bila napačna, izmerjeno na obeh uradnih binarkah). Zdaj je `loop=true`;
  kadenca ostane EN klip na odprtje vrat na obeh buildih (2.2.4: okno se
  zapre pred koncem klipa + ponovni pregled predikata ob meji; 2.4.6:
  zaklepka spodaj).

### Kaj se prižge ob nadgradnji na Liquidsoap 2.4.6 (D1)

- **Avtomatski učinki prehodov**: spala plast sweep/washout/dissolve se ni
  več oborožuje ročno (CLI). Pisec seznamov (`director/playlist.js`
  `annotateTrackEntry` — skupen writer za filler.m3u in oddajne liste)
  žiga učinke SAMODEJNO iz istih meritev, deterministično:
  `liq_washout` na EPskem izumrtju (rep ≥ 6 s in ≥ 10 dB globok),
  `liq_dissolve` na globoki ambientni zgradbi (glava ≥ 3,5 s in ≥ 10 dB),
  `liq_sweep` na GLASNEM hladnem začetku (napad ≤ 500 ms in LUFS ≥ −9,5).
  Redkost je namen: vsak prag vpraša "je ta šiv trenutek?", pošten privzet
  odgovor pa je ne — ravninski crossfade ostaja delovni konj.
  `stampTransitionFlags.js` CLI ostaja za ročne popravke.
  Doktorjevo preverjanje **prehodi** (#19) meri pokritost teh žigov v
  filler.m3u — po nadgradnji mora biti plast pripravljena, ne presenečena.
- **Urna ID plošča ne more čez DJ govor** (Val 31, B3 — odkloženo): okno se
  razširi na prvih 90 s ure in govorna vrata (source_tag="speech") držijo
  klip nazaj, dokler DJ govori; ID nato zazveni čez intro pesmi, ki sledi
  govoru (klasični »ID čez rampo«), ali točno ob :00:00, če že teče glasba —
  kot prej. Izbrani klip se vedno predvaja do konca tudi, če se vrata zaprejo
  sredi (govor, ki začne ob :00:03, ne odreže ID-ja, ki je že na etru).
  Enkratna zaklepka (`id_fired`) zagotavljuje NATANČNO EN klip na okno tudi
  s širokim oknom in neskončnim bazenom. Iskrena meja: govor, ki teče čez
  90. sekundo ure, ta uro ID preskoči (poteptan DJ je hujši od izpuščenega
  žingla). Vrata so izključno DJ govor — stingerji, promosi in postelje
  ohranjajo današnje vedenje prek glasbe. Vsa semantika izmerjena na
  uradni 2.4.6 binarki (minute-ciklične sonde istega ožičenja); startup
  privzetek je fail-closed (neznan program ≙ govor → ID čaka ~1 s).

### Zavestno odloženo (iskreno)

- **Urnina ID plošča čez govor** (B3): DOSTAVLJENO v valu 31 (razdelek
  zgoraj) — vrata so odprta zgolj na 2.4.6, na 2.2.4 ostaja cookbookov
  `{0m0s}` overlay (bajtno-identično).
- **Hit-the-post** (govor čez intro pesmi): zahteva detekcijo začetka
  vokala — ostaja na seznamu idej.
- **BPM/stem prehodi**: dokumentirano zavrnjeno (proti arhitekturi brez AI).
