# Auto Radio (način `autoRadio`) — radio brez jezikovnega modela

Ta dokument opisuje **avtomatski način** delovanja Radio Markec: popolnoma
deterministično radijsko postajo brez jezikovnega modela (LM Studio) in brez
nevronskih TTS modelov (Chatterbox). Glasba se izbira po pravilih, govor se
sestavlja iz predlog, zvok pa prihaja iz vnaprej posnetih posnetkov ali
klasičnih sintetizatorjev (Windows SAPI / espeak-ng).

> Zasnova: ista orkestracija kot pri AI načinu (urnik → producent → direktor
> → Liquidsoap/Icecast), le da so vse odločitve podane v podatkih in
> predlogah. AI pot ostane nespremenjena in vedno na voljo — `autoRadio` je
> izklopna zastavica, ne zamenjava celotnega sistema.

## Kaj je spremenjeno v primerjavi z AI načinom

| Faza | AI način (privzeto) | autoRadio način |
|---|---|---|
| Razlaga briefa (»## Track Selection«) | LLM (`producer/trackSelection/query.js`) | deterministični parser (`auto/briefQuery.js`) |
| Izbira skladb | deterministična (`trackSelection/queue.js`) | ista koda + dodatna pravila (`auto/rules.js`) |
| Raziskava dejstev | Wikipedia (`producer/research/`) | metapodatki iz knjižnice (izvajalec, naslov, album, leto, žanr) |
| Pisanje DJ vrstic | LLM (`producer/moves.js`, `boundaryWalk.js`) | predloge (`auto/templates.js`, `scriptBuilder.js`) |
| Pregled skripte | LLM (`producer/reviewScript.js`) | ne potreben (predloge se ne ponavljajo) |
| Žive segmente (čas/vreme) | LLM (`director/liveSegments.js`) | predloge + pravi podatki Open-Meteo (`auto/liveLines.js`) |
| Glas (TTS) | Chatterbox (`director/tts.js`) | posnetki / SAPI / espeak / brez (`auto/voice.js`) |

Vse ostalo — urnik (`station.json`), predkúšnja (prewarm), direkcija,
`playlist.m3u`, spletna stran, studio, Android aplikaciji, scrobbling — dela
enako kot prej.

## Vklop

1. V `config.json` dodaj blok `autoRadio` (glej `config.example.json`) in
   nastavi `"enabled": true`.
2. Bloka `lmStudio` in `chatterbox` lahko izbrišeš — postaja jih ne obiskuje
   več. (Ostanejo lahko tudi; autoRadio ima prednost.)
3. Ponovno zaženi storitev. Producent se prek isti zastavice preklopi v
   deterministično pot, direktor pa v brezmodelni govor.

Primer minimalnega bloka:

```json
"autoRadio": {
  "enabled": true,
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
enako. `ratingKey` je stabilen zgoščen poti datoteke.

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
  izgovori DJ (glej predloge); bloku se lahko doda tudi `preferredGenres`
  kot mehko žanrsko usmerjanje za prihodnost.

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
  slot spusti segment kot v `clips` načinu.
- **`none`** — brez govora sploh: postaja predvaja glasbo (+ jingle), vsa
  besedila pa ostanejo v `script.md`/`transcript.json`.

Vsi viri se ob prvi uporabi normalizirajo v pcm_s16le/24 kHz/mono (isti
kodekski dogovor, ki ga je imel Chatterboxov izhod), zato spajanje sosednjih
govornih odsekov ostane brez izgub. SAPI/espeak/edge/piper izhod dobi še
`djDrops.gain`; posnetki (clips, pregenerated) ostanejo netaknuti.

## Rubrike (`autoRadio.rubrics` / vrstica `Rubrike:` v briefu)

Poleg glasbe lahko oddaja prebere **resnične podatke** iz slovenskih virov —
vedno deterministično, brez jezikovnega modela. Oddaja jih zahteva z vrstico
`Rubrike:` v briefu (šumniki so neobčutljivi):

```markdown
Rubrike: vreme, novice, šport, obzorje, zanimivosti, glasba
```

| Rubrika | Vir | Slot | Predloga |
|---|---|---|---|
| `vreme` | **ARSO** — uradna meteorološka služba RSS (opazovanja, ~20 slovenskih postaj, slovenski opisi) | `weatherNow` | `weatherNow.withTemp` / `.tempOnly` / `.generic` |
| `šport` | **RTV Slovenija** športni RSS — sveže naslovnice | `sportHeadlines` | `sportHeadlines` |
| `novice` | **RTV Slovenija** novični RSS — naslovnice iz Slovenije in sveta | `newsHeadlines` | `newsHeadlines` |
| `obzorje` | **Wikidata** — rojstva/smrti na današnji dan, samo entitete s slovensko oznako, spol iz P21 (rodil/rodila, umrl/umrla) | `obzorje` | `obzorje.birth`/`.birthF`/`.death`/`.deathF` |
| `glasba` | **Wikidata** — isto kot `obzorje`, a filtrirano na glasbenike (poklic P106, podrazredi Q639669 "glasbenik") — rubrika "Na današnji dan v glasbi" | `obzorjeGlasba` | `obzorjeGlasba.birth`/`.birthF`/`.death`/`.deathF` |
| `zanimivosti` | **MusicBrainz** (leto nastanka, država, žanri za skupine) + **sl.wikipedia** povzetek kot rezerva + **lokalni korpus** splošnih rock zanimivosti (`src/auto/rockFacts.js`, deluje brez omrežja) | `triviaArtist` / `triviaGeneral` | `triviaArtist` / `triviaGeneral` |

Nastavitve v `config.autoRadio.rubrics`:

- `station` — ARSO postaja (npr. `"Ljubljana"`; ujemanje: točno → začne se z →
  vsebuje-najkrajše, tako da `"Ljubljana"` najde mestno postajo, ne letališča)
- `newsLimit` — koliko novičnih naslovnic (privzeto 3)
- `sportLimit` — koliko športnih naslovnic (privzeto 4)
- `onThisDayLimit` — koliko dogodkov "na današnji dan" (privzeto 2)
- `onThisDayMusicLimit` — koliko glasbenih dogodkov "na današnji dan" (privzeto 2)
- `triviaMaxArtists` — na koliko unikatnih izvajalcev na oddajo se sploh poizveduje (privzeto 6)
- `triviaGeneralCount` — koliko splošnih rock zanimivosti na oddajo iz korpusa (privzeto 3)
- `timeoutSeconds` — trdi časovna omejitev za vsak vir (privzeto 10)

Dogovor je vedno enak: **vir odgovori → segment je v oddaji; vir odpove ali
čas poteče → segment spusti, oddaja teče dalje.** Odgovori so v procesu
predpomnjeni (vreme 15 min, šport 30 min, obzorje 6 h, izvajalec 24 h), tako
da prewarm in ponovni zagoni ne obremenjujejo virov. Rubrika ni del oddaje,
če je ni v briefu; `--offline` (preview) jih vedno spusti — **razen korpusne
polovice `zanimivosti`**, ki je lokalna datoteka in deluje brez omrežja (samo
polovica za izvajalce se ob offline spusti).

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

Privzete predloge so slovenske (glej `src/auto/templates.js`). Vsak slot je
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
| `{condition}` / `{temp}` / `{wind}` | vreme (slovensko, °C, km/h) |

Sloti: `open` in `close` imajo tudi različice po časovnih blokih
(`morning`/`daytime`/`evening`/`night` + `default`); `recap` se sam odloči
med različicami z albumom+letom, samo letom ali splošno — glede na to, kaj
knjižnica res ve. Preprost kviz (ugibanje leta) uporablja `quizIntro` in
`quizReveal`.

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

## Orodja

- `npm run themed-shows -- list | brief <tema> | ensure <tema> [minute] | resolve`
  — katalog tematskih oddaj: seznam, predogled izrisanega brifa, pisanje
  brifa na disk in »katera tema je ta teden na vrsti« za vsak special slot.

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

## Zapisi, ki ostajajo odprti (PoC)

- `artistList` teme ostajajo ročne (brez modela ni razširjanja konceptov).
- `singleAlbum` v lokalnem načinu ni podprt (Plex albumni metadata).
- Bloki še ne vplivajo na izbiro žanrov (`preferredGenres` je pripravljeno
  polje, uporabe še ni).
- Popolna determiniranost zaporedja je zavestno zmehčana: izbira uporablja
  naključni miks znotraj pravil (kot prej), le različice predlog in posnetkov
  so povsem odločene z zgoščevalom.
