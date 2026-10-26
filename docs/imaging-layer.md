# Imaging sloj: ID ob polni uri, stingeri, promosi, emergency podlaga, postelje

*Datum: 2026-10-24 · Radio Markec main, Liquidsoap 2.2.4-1+dev · del P1/seznama izposojenih vzorcev (docs/ready-made-scripts-analysis.md, točke #1, #3, #9) · promosi dodani v valu 21 (Paket B2, docs/programming-research.md §5) · samodejne postelje (formatna ura) v valu 23 (Paket D1)*

Imaging sloj doda štiri radijske sloje, ki jih je programu do zdaj manjkalo: **ID postaje ob polni uri**, **periodne stingerje**, **promose** (urniške napovedi prihodnjih oddaj) in **emergency podlago**. Vse štiri izvaja `liquidsoap/radio.liq`, Node pa vzdržuje njihove plejliste z isto pogodbo, ki jo že uporablja `now_playing.m3u`/`filler.m3u` (Node piše, Liquidsoap opazuje z `reload_mode="watch"`). Klipi so kratki proizvedeni posnetki (TTS/ffmpeg), ki jih operater polni v štiri direktorije pod `dataDir/imaging/` — z eno izjemo: promo klipe SAMODEJNO producira `scheduler/promoProducer.js` iz dejanskega urnika (Paket B2, razdelek 4 spodaj); operaterjevi klipi so tam prav tako doma. Peti, mehanizemsko drugačen sloj — **postelje** (P3 #12, od 2026-10-24 z duckerjem iz P3 #13) — ne živi v teh direktorijah: klip prileti po telnetu (`beds.push`), glasba pa utihne pod njim; razdelek pod tabelo.

## 1. Arhitektura štirih slojev

```
show_source (preproduced)  ─┐
                            ├─ fallback(track_sensitive=false)  = jedro programa
filler_source (glasba)     ─┘
        │
        ├─ fallback(track_sensitive=true, [delay(1800., stingers), …])   ← stingeri
        ├─ fallback(track_sensitive=true, [delay(1200., promos), …])     ← promosi (Paket B2)
        ├─ add([…, switch([({0m0s}, id)])])                              ← ID overlay
        ├─ sidechain ducker (rms.smooth + on_frame + amplify)            ← postelje (P3 #13, nadomešča #12 smooth_add)
        ├─ blank.detect + blank.strip (max_blank=20.)                    ← dead-air stražar (P2 #9)
        ├─ amplify(override="liq_amplify")
        └─ mksafe(fallback(track_sensitive=false, […, emergency]))       ← emergency
             └─ blank.detect (track_sensitive=false)                     ← opazovalec ZRAKA
```

Vrstni red je »od zunaj navznoter«: stingeri vstopajo na mejah skladb, ID se zmeša NAD mešanico, emergency leži pod vsem programom, šele pod njim je mksafe-ova tišina. Vsak vir je `playlist()` (fallible): **prazen ali manjkajoč .m3u pomeni, da sloj preprosto ni na voljo** — postaja z brez imaging sredstev se obnaša točno kot prej. Degradacijska lestvica je »izpusti sloj«, nikoli »izpusti program«.

**Dead-air stražar (P2 #9, popolnitev te lestvice, 2026-10-24):** emergency podlaga lovi samo vire, ki so *nedosegljivi* (prazna m3u) — ne vira, ki igra digitalno tišino (pokvarjen/tih encode ostane "available"). To zapre `blank.strip()` (uradni cookbook recept (5), semantika verificirana iz tega builda `noblank.ml`): po 20 s neprekinjene tišine postane program nedosegljiv, emergency zasede, ob zvoku program vrne. Dva opazovalca `blank.detect` (isti akumulator, pasivna) pišeta vsak prehod v `dataDir/history/deadair.jsonl` (`src/deadair/recordEvent.js`), Diagnostics pa parira epizode (`src/deadair/ledger.js`): `program_*` = "stražar je deloval", `air_*` = "odpovedal je tudi nujni vir". Parametri so literali v radio.liq (json.parse tip nedotaknjen); reverzibilno = izbriši tri vrstice + štiri handlerje. Live verifikacija: `liquidsoap --check` + namerno tih WAV v now_playing.m3u.

**Postelje (P3 #12 → #13, 2026-10-24) — napoved ČEZ glasbo, ne na njeni meji:** četrti sloj mehanizemsko ne spada v m3u pogodbo zgoraj — njegov vir je `request.queue(id="beds")`, ki ga Node polni po telnetu (`src/liquidsoap/bedQueue.js`: `push <klip>` / `queue` / `skip`). Prva različica (#12) je mešala prek vgrajenega `smooth_add`: ko vrsta drži klip, program utihne na 0.2 za CELO trajanje klipa — tudi med pavzami v govoru. Od P3 #13 meša **sidechain ducker** po vzorcu buildovega `normalize()` (vse preverjeno v tar 2.2.4): `rms.smooth` meri dejansko glasnost klipa (glajen RMS, τ=50 ms), `source.on_frame` vodi ovojnico na vsak frame, `amplify({getter})` z držo ref spusti program na 0.2 samo MED govorom (napad τ≈20 ms) in ga spusti nazaj med pavzami ter po koncu klipa (spust τ≈0,5 s); histereza (odpri 0.02 / zapri 0.008) preprečuje črpanje na medbesednih presledkih; `source.is_ready` prepreči zamrznjen zadnji RMS ob izpraznjeni vrsti. Klip gre v mešanico na 0.8, vsota ~1.0 (kot pri #12). Zakaj ne dobesedno `sidechaincompress`: to je FFmpeg FILTER, ne LS operator — v nobenem LS 2.x ga ni (verified tar 2.2.4 + upstream v2.3.0/v2.4.0/main), FFmpeg pot bi zahtevala `ffmpeg-avfilter` build + muxer dvotirni graf. Notranji takojšnji vstop SREDI skladbe je zdaj naravna posledica `add()` (bistvo postelje, nasprotje stingerjem na mejah). Postavljen NAD ID overlay in zahtevke (napoved prekaša vse glasbeno), POD programskim dead-air opazovalcem (opazovalci vidijo mešanico — klip čez tiho verigo je slišan radio, ne mrli zrak). Klip za posteljo je navaden producirani WAV/MP3 (vremenska rubrika, produciran govor); od valu 23 (Paket D1, razdelek 5 spodaj) postaja te klipe tudi SAMODEJNO producira in potiska `scheduler/formatClock.js` — »ločena prihodnja odločitev« je postala sprejeta odločitev. Polna obrazložitev: docs/ready-made-scripts-analysis.md §2.6 (STATUS P3 #13).

| Sloj | Vir | Kdaj zazveni | Vedenje brez klipov |
|---|---|---|---|
| ID postaje | `imaging/id.m3u` | overlay točno ob HH:00:00 (`{0m0s}`) | sloj ne obstaja |
| Stingeri | `imaging/stingers.m3u` | na prvi meji skladb po preteku intervala (30 min) | sloj ne obstaja |
| Promosi | `imaging/promos.m3u` | na prvi meji skladb po preteku intervala (20 min) | sloj ne obstaja |
| Emergency | `imaging/emergency.m3u` | šele, ko sta show IN filler nedosegljiva | mksafe-ova tišina (kot prej) |
| Postelje | `beds.push` prek telnet (ni m3u); od Val 23 jih proizvaja tudi formatClock (razdelek 5) | TAKOJ, sredi skladbe — glasba utihne na 20 %, samo med govorom | prazna vrsta = sloj ne obstaja |

## 2. Verificirane semantike operatorjev (primarni viri)

Vsaka odločitev v bloku ima dobesedno preverjen vir — v2.2.5 izvorni kodi/dokumentaciji (najbližja verziji 2.2.4-1+dev):

- **`delay(1800., stinger_source)`** — `src/core/operators/delay.ml` (v2.2.5): »Avoids some source to play a new track before some delay elapses after the end of the previous track played.« Po koncu vsake stinger skladbe je vir nedosegljiv do preteka intervala; ob zagonu je `last = 0.`, torej ob zagonu zazveni **natančno en** stinger na prvi meji skladb, kasneje največ ena na interval. Zunanji `fallback(track_sensitive=true)` je tisto, kar stingerje drži na mejah skladb — s `track_sensitive=false` bi rezel glasbo sredi skladbe takoj, ko interval poteče.
- **ID overlay** — uradni cookbook 2.2.5, sekcija »Mixing and switching«: `add([normal, switch([({0m0s}, jingle)])])`. Switch **nima default veje**: pred :00 je nedosegljiv in ne prispeva ničesar; ob :00 postane na voljo in začne klip takoj (nima tekoče skladbe, zato `track_sensitive` ne zavira), klip pa se zmeša NAD programom.
- **Zakaj NE `predicate.activates`** — `src/libs/predicate.liq` (v2.2.5): `ans = (not last()) and cur` — rob false→true je opazljiv samo ob vzorčenju predikata. Pri `switch` z mejskim re-selectom lahko meja skladbe pade izven okna `0m-5m` in ID bi tiho izpustil cele ure. Cookbookov recept deluje zanesljivo ravno zato, ker overlay switch v stopnji »nedosegljiv → dosegljiv« ne čaka nobene meje.
- **Zakaj `playlist()` in ne `single()` za emergency** — fallible vir, ki je nedosegljiv, dokler je plejlist prazen, drži degradacijsko lestvico iskreno; `single()` z manjkajočo datoteko ima na tej verziji mutnejšo semantiko dostopnosti.
- **mksafe** — `src/libs/source.liq` (v2.2.5): `fallback(track_sensitive=false, [s, blank])` — ostaja zadnja mreža pod emergency.

## 3. Datoteke in poti

Node stran (src/config/index.js izvaja vse iz `dataDir`):

| Pot | Namen |
|---|---|
| `dataDir/imaging/id/` | ID klipi (priporočeno 2–5 s, s podlago) |
| `dataDir/imaging/stingers/` | stinger klipi (priporočeno 2–10 s) |
| `dataDir/imaging/promos/` | promo klipi — samodejno iz urnika (Paket B2) in/ali operaterjevi |
| `dataDir/imaging/emergency/` | emergency klip(i) — predvajani v zanki, dokler program ne pride nazaj |
| `dataDir/imaging/id.m3u` | piše `scheduler/imagingPlaylists.js` |
| `dataDir/imaging/stingers.m3u` | ″ |
| `dataDir/imaging/promos.m3u` | ″ (osveži ga takoj po vsakem valu tudi `promoProducer.js`) |
| `dataDir/beds/` | klipi samodejnih postelj (formatClock.js) — NI m3u plast, datoteka tu ne gre na eter sama od sebe |
| `dataDir/imaging/emergency.m3u` | ″ |

Vsak vnos nosi eksplicitno `annotate:liq_fade_in="0"` (trd rez — imaging klipi so govorna družina, točno kot DJ govor pri director/playlist.js). Direktorij se skenira ravno (brez rekurzije), samo pripon `.mp3 .flac .m4a .ogg .opus .wav` (neobčutljivo na velikost črk); izpis je sortiran, da se `watch` reload sproži le, ko se je *nabor* klipov res spremenil. Manjkajoč direktorij → **prazen .m3u** (iskrena degradacija, nič izmišljenih vnosov); povzetek z števci se vrne klicatelju in testirajo testi, ne log parsanja.

Job v schedulerju: `imaging` vsake `config.imaging?.checkIntervalMinutes ?? 30` minut (brez bloka se obnaša kot prej — lekcija F2 razreda napak z 2026-10-24). Ponovni zapis je hkrati tudi to, kar *nafila izčrpan bazen*: `id.m3u` z enim klipom in `loop=false` je po odigranem klipu prazen do naslednjega prepisa (največ interval kasneje), kar ID drži enkrat na uro.

Literáli v `liquidsoap/radio.liq` so namerno literáli (kot `{0m0s}`): `1800.` = stinger interval v sekundah, `1200.` = promo interval (razdelek 4). `radio.liq`-jev `json.parse` tip ostaja nespremenjen, zato starejši `config.json` brez imaging bloka zažene postajo brez sprememb. Reverzibilnost: odstrani imaging blok iz `radio.liq` in štirje sloji izginejo; Node job piše .m3u datoteke, ki jih potem nihaje ne bere (neškodljivo).

## 4. Promosi (Paket B2): samodejna produkcija iz urnika

Promosi so četrti m3u sloj in prvi, ki ga NE polni operater: `scheduler/promoProducer.js` (job `promo_producer`) bere **dejanski urnik** (`scheduleUtil.nextOccurrences` — oddaje, ki se še niso začele), iz vsake pojavitve sestavi slovenski promo stavek iz predlog `promo`/`promoHost` (`src/auto/templates.js`, lastnik jih lahko prepiše prek `config.autoRadio.templates`), ga sintetizira prek obstoječe Edge TTS poti (`src/auto/edgeTts.js`, glas po osebi ali globalni `autoRadio.voice.edgeVoice`) in glasnost **zapeče v datoteko**: en ebur128 prehod (`lib/autocue.js` `analyzeTrack`) + `ffmpeg -filter:a volume=XdB`, cilj iz `config.autocue.targetLufs` (privzeto −16), pozitivna stran ograničena z `maxGainDb`. Zakaj pečeno in ne annotate: imaging klipi nikoli ne nosijo `liq_amplify` (govorna družina — radio.liq `amplify(override=...)` je zanje pass-through), zato mora popravek sedeti v bajtih.

**Dan je VEDNO ime dneva tedna** (»v torek«, `lib/time.js` `slovenianWeekdayPhrase`) — nikoli »danes«/»jutri«: promo klip živi v bazenu ure, relativna beseda, narejena ob 22:00, bi zgnila po polnoči. Ime oddaje in voditelja prineseta brief (isti `resolveShowInfo` kot `/api/schedule`): oddaja z voditeljem dobi predlogo `promoHost`, brez njega `promo` — »z voditeljem« brez voditelja nikoli ne obvisi v stavku.

### Nastavitve (`config.imaging.promos`)

| Ključ | Privzeto | Pomen |
|---|---|---|
| `enabled` | `false` | OPT-IN: plast, ki govori NA ETRE, se na obstoječi namestitvi nikoli ne oglaši sama (odsoten blok = izklopljeno, job se sploh ne registrira) |
| `checkIntervalMinutes` | 30 | kadenca joba `promo_producer` |
| `horizonHours` | 18 | kako daleč v prihodnost se producejo klipe (oddaja za 20 h ne obstaja v bazenu — njena ura še ni programska obljuba) |
| `maxClips` | 8 | zgornja meja klipov na val (Edge klici so sekunde, a brez meje bi nedeljski večer s praznim urnikom rad walkal cevovod) |
| `persona` | *(ni v config.example.json)* | ime osebe (`autoRadio.voice.personas`) — izpuščeno namenoma: globalni Edge glas je zdrava privzetost; kadar je nastavljena, velja kaskada `edgeVoiceForPersona` (oseba → globalni glas → `sl-SI-RokNeural`), prozodija sledi isti kaskadi |

### Imenovanje in lastništvo datotek

Generirani klip se imenuje `promo_<id-oddaje>_<datum>_<čas>.mp3` (npr. `promo_podkast_2026-11-03_20-00.mp3`). Deterministično ime JE varovalka pred ponovnim delom: obstoječa datoteka pomeni preskok (naslednji tik z nespremenjenim urnikom ne naredi NIČ). Po vsakem valu job počisti odmrle generirane klipe — take, katerih `<datum>_<čas>` ni več v oknu. **NOSILEC VAROVANKE: samo datoteke, ki ustrezajo generiranemu vzorcu `promo_*_YYYY-MM-DD_HH-MM.mp3`, se kadar koli pobrišejo — operaterjev klip (vsako drugo ime: `moj-promo.mp3`, `december_prireditve.mp3`, …) je za ta job nedotakljiven, za vedno.** Operaterjevi klipi so v bazenu enakovredni: vse, kar je v `promos.m3u`, gre na eter.

### Degradacijska lestvica

| Stanje | Vedenje |
|---|---|
| `imaging.promos.enabled` ni `true` | job se sploh ne registrira (brez bloka = izklopljeno) |
| Edge TTS pade (429, ukinjen socket) | klip se preskoči z eno iskreno vrstico v dnevniku, naslednji tik poskusi znova (datoteka ni pristala, zato ni preskoka) |
| ebur128/ffmpeg padeta | klip pristane NEIZMERJEN (»unmeasured — station unaffected«): rahlo napačna raven je boljša kot manjkajoči promo, vrhnji limiter (radio.liq `compress` pred `output.icecast`) še vedno lovi vrhove |
| prazen/izbrisan direktorij | prazen `promos.m3u` → plast ne obstaja (ista lestvica kot vsi imaging sloji: »izpusti sloj«, nikoli »izpusti program«) |

### Interval 1200. (20 min) in trk s stingerji

Promo `delay(1200., …)` je NAMENOMA različen od stingerskega `1800.`: enaka intervala bi se velikokrat sprožila na isti meji skladb in zložila promo na vsak stingerov šiv — 20 in 30 minut se izmenjujeta, zato se plasti slišijo ločeno. Oba sta literala (ista politika kot `{0m0s}`): tip `json.parse` ostane nedotaknjen.

### NAMIG ZA NAMESTITEV

Predloga `radio.liq` iz `deploy/ubuntu/install.sh` **nima** `promo_source` (nima ga niti stingerskega bloka v tej obliki referenčne datoteke — imaging sloji živijo samo v referenčnem `liquidsoap/radio.liq`, enaka znana omejitev kot `Opus/FLAC mounti`, glej DEPLOYMENT_GUIDE.md). Prižiganje `imaging.promos.enabled` na namestitvi, ki poganja namestniško predlogo, BI produkcijo poganjalo, klipe pa ne bi šli nikamor na eter — dokumentirano in zavestno nepreneseno.

## 5. Formatna ura (Paket D1, Val 23): postelje, ki jih postaja proizvaja sama

Peti sloj po pomenu (vreme ob `:15`/`:45`, napoved naslednje oddaje N minut
pred preklopom), a mehanizemsko NI imaging m3u plast: klip pride na eter kot
**postelja** čez telnet (`beds.push`), glasba pa se pod njo utiša z že
opisanim sidechain duckerjem. `radio.liq` SE NI SPREMENIL niti za en znak —
celoten Paket D je `scheduler/formatClock.js` nad obstoječo strojno opremo.

Delovni tok: tik (privzeto 6 s) izračuna `fireTime` vsakega dogodka →
dogodek znotraj `[fireTime, fireTime + 45 s)` **sproži** potisk obstoječega
klipa (enojni poskus, ključ v `history/beds-fired.jsonl` po vzoru
`push/sent.jsonl` preprečuje dvojne izstrele prek restartov) → dogodek
znotraj `produceLeadMinutes` pred svojo minuto se **producira** (vreme:
`fetchCurrentWeather()` z dejanskega Open-Meteo vira, °C/km/h, brez
temperature ni poročila — P4 #29; napoved: H1 naslov + voditelj iz briefa
kot `/api/schedule`; besedilo iz predlog `bedWeather`/`bedNextShow`
(`config.autoRadio.templates`, lastnik jih lahko prepiše); Edge TTS; ena
ebur128 izmera zapečena v bajte — §4-ina disciplina). Klip za vreme nosi
dan v tisti obliki, ki velja ob ČASU SPROŽITVE (`slovenianDayLabel` proti
`fireTime` — »jutri« ob 23:57 za oddajo po polnoči).

Datoteke: `dataDir/beds/weather_<datum>_<HH-MM>.mp3` in
`nextshow_<id>_<datum>_<HH-MM>.mp3` (deterministično ime = varovalka pred
ponovnim delom), `dataDir/history/beds-fired.jsonl` (knjiga sprožitev,
pokrita z dnevno varnostno kopijo). Pometanje pobriše SAMO generirana imena
(`weather_*`/`nextshow_*` z datumom in uro — nosilec varovanke iz §4-inega
promo vzorca dobesedno: operaterjeva datoteka katerega koli drugega imena
je za job nedotakljiva, za vedno). `beds/` NI m3u plast — datoteka,
odvržena vanj, ne gre na eter sama od sebe; operaterjeve postelje se
potiskajo ročno (`node src/liquidsoap/bedQueue.js push <datoteka>`).
Odmrli klipi gredo po `clipRetentionHours` (privzeto 2 h; 0 = večno).

| Stanje | Vedenje |
|---|---|
| `imaging.beds.enabled` ni `true` | job se sploh ne registrira (OPT-IN: plast, ki GOVORI na etru, se ne prikaže nepovabljena) |
| Open-Meteo padel / ni temperature | klipa ni → slot sproži nič (sloj odsoten, program nedotaknjen), naslednji znamen poskusi znova |
| Edge TTS pade | klip ne pristane → enako kot zgoraj; tik, ki ga najde že na disku, ne dela nič |
| ebur128/ffmpeg padeta | klip pristane NEIZMERJEN (»station unaffected« — vrhnji limiter lovi vrhove) |
| Liquidsoap zavrne potisk (mrtv telnet / namestniška predloga brez `beds`) | zavrnitev se izpiše dobesedno, ključ se zapiše (enojni poskus), program nedotaknjen |
| opravila prek noči (downtime) | postelje tečejo TOČNO KO URNA PREDLOGA — celonočni ID overlay (`{0m0s}`) tudi ne utihne ob downtimeu; kdaj ne jesti vremena, je lastnikova odločitev prek `weatherMinutes` |

NAMIG ZA NAMESTITEV (isti razred kot promosov): namestniška predloga
`radio.liq` nima vrste `beds` — prižiganje `imaging.beds.enabled` tam
pomeni poštene zavrnitve potiska v dnevniku. Celoten časovni model,
nastavitvena tabela in ograja o svežosti: `docs/auto-radio.md`, razdelek
»Paket D (Val 23)«.

## 6. Proizvodnja klipov ID/stingerjev/emergency (enkratna, izven repozitorija)

Klipi treh ročnih slojev so stvar produkcije, ne runtime — deterministično, brez LLM (promosi so izjema, glej razdelek 4):

- **ID postaje** (2–5 s, s podlago): TTS stavek (»Radio Markec«) prek obstoječe Edge TTS poti (`src/auto/edgeTts.js`) ali `edge-tts --voice sl-SI-RokNeural`, nato zmešan s podlago in končan z vnaprej renderiranim fade-out (isti pristop kot jingle pri `lib/audio.js` — na runtime NI fade.out, znani bug 2.2.4). Glasnost poravnaj z glasbo (cilj okrog −16 do −18 LUFS), ker gre overlay čez program.
- **Stingeri**: enak postopek, krajši stavki (»Sledi Radio Markec«, »Ob polnih urah Radio Markec« …). Brez podlage, če bodo rezani med skladbe.
- **Emergency**: en klip, ki v zanki sporoči, da je postaja pokvarjena (TTS: »Trenutno imamo tehnične težave …«), ali 30 s rožnati šum:
  `ffmpeg -f lavfi -i anoisesrc=color=pink:amplitude=0.2:duration=30 -ar 44100 -ac 2 emergency.wav`
  Če je direktorij prazen, emergency sloj ne obstaja in mksafe-ova tišina ostane (obnašanje kot prej) — klip je izboljšava, ne pogoj.

Dodajanje klipov: copy v ustrezni direktorij; naslednji imaging tick (največ 30 min, ali ročno `node src/scheduler/imagingPlaylists.js`) prepiše .m3u in `watch` reload jih takoj upošteva — brez restarta Liquidsoapa.

## 7. Verifikacija

- **Testi** (99/99, `npm test` — zgodovinski posnetek imaging vala;
  suite je od takrat zrasla, število ni več aktualno, tekoče preveri
  `npm test`): `test/imagingPlaylists.test.mjs` — nabor pripon, trd rez annotate, prazen/manjkajoč direktorij → prazen .m3u, iskren povzetek, praznjenje ob rescanu; `test/radioLiqImaging.test.mjs` — strukturna regresija nad radio.liq **brez komentarjev** (komentarji namenoma omenjajo pokvarjene konstrukte, zato se skenira samo koda): overlay switch prisoten, `predicate.activates` odsoten, `delay(1800., …)` + track_sensitive fallback prisotna, emergency kot playlist pod programom, mksafe zadnji, `crossfade(`/`fade.out(` in `single(` ne smejo priti nazaj.
- **Postelje**: `test/bedQueue.test.mjs` — ožičenje radio.liq po vrstnem redu (ducker nad ID overlayjem, pod dead-air opazovalcem; popolna odsotnost smooth_add; histereza/napad/spust literali; override=null() nad R128 amplify), telnet pogodba push/queue/skip proti lažnemu strežniku. Na boxu: `liquidsoap --check` je edina preverba, da `rms.smooth`/`source.on_frame`/`source.is_ready` obstajajo v buildu (vsi stdlib brez neobveznih odvisnosti); potem `node src/liquidsoap/bedQueue.js push <klip.wav>` in poslušanje: utih ob začetku govora, nazaj med pavzami in po koncu klipa.
- **Na produkcijski mašini** pred restartom: `liquidsoap --check liquidsoap/radio.liq` (parse-only) in posluš prve polne ure: ID točno ob :00, stinger na prvi meji po ~30 min, emergency slišati le, če programu nameravano odvzameš oba vira (test ročno: preimenuj začasno now_playing.m3u in filler.m3u).

- **Promosi**: `test/promoProducer.test.mjs` — vrata (odsoten blok = `skipped: true`, brez datotek), izris besedila iz pravega briefa (naslov H1, ura, fraza dneva tedna, postaja; brez voditelja BREZ »z voditeljem«), okno (horizont/maxClips), deterministični preskok (drugi val: 0 produkcij, samo reuse), čiščenje odmrlih (generirani pobrisan, operaterjev NEDOTAKNJEN — nosilec varovanke), glasnostni filter (`volume=4dB` argv, ničelna amplify brez ffmpeg, padla analiza — klip kljub temu pristane »unmeasured«), odpoved Edge (errors[], ostali klipi živijo), pisanje `promos.m3u` z žigom `source_tag="promo"` na koncu vala. `test/imagingPlaylists.test.mjs` krije četrti sloj (.m3u izpis, prazen direktorij, žig), `test/sourceTag.test.mjs` zaprt nabor oznak (sedem, z `promo`), `test/radioLiqImaging.test.mjs` strukturni pini `promo_source`/`delay(1200.)`/ožičenje + protizdrs (promosi NE `mode="normal"`, stinger ostane 1800., install.sh BREZ promo_source). Na boxu: `liquidsoap --check liquidsoap/radio.liq`, prižgi `imaging.promos.enabled`, počakaj tick (ali `node src/scheduler/promoProducer.js`) in posluš promos na prvi meji skladb po 20 min.
- **Formatna ura**: `test/formatClock.test.mjs` (40 testov) — vrata, nastavitvene odločitve (vključno `[]` = vreme izklopljeno, `0` = napoved izklopljena), slotna aritmetika (meje 45-sekundskega okna, prek polnoči), sprožitve z enojnim poskusom (zavrnitev/izjema/pogrešan klip vse zapišejo ključ), produkcija z izmero/padci ebur128-ffmpeg, pometanje (generirana imena s/pol srednjega člena — ujeto prav tu: promosova oblika vzorca nikoli ne bi ujela vremenskih imen), knjiga sprožitev (raztrgane vrstice, rezanje), sočasnost tika, predloge + lastnikov prepis. Na boxu: prižgi `imaging.beds.enabled`, postavi `weatherMinutes` na minuto ~2 min pred zdaj, počakaj produkcijo v `dataDir/beds/` in sprožitev v dnevniku (ali takoj `node src/scheduler/formatClock.js`).

## 8. Viri

savonet/liquidsoap v2.2.5: `src/core/operators/delay.ml`, `src/libs/predicate.liq`, `src/libs/source.liq` (mksafe), cookbook »Mixing and switching« / »Periodic playlists«; SUB/WAVE radio.liq (dead-air stražar, minimalna oblika); docs/ready-made-scripts-analysis.md v2 (točke #1, #3, #9 in matrika); AzuraCast nit #6252 (radijski standard prehodov — omenjen kot kontekst za prihodnji autocue korak, ki je ločen projekt P1 #2); tar 2.2.4 `src/libs/audio.liq` (normalize vzorec: rms.smooth + on_frame + amplify getter), `src/core/operators/{rms_smooth,amplify}.ml`, `src/core/builtins/builtins_source.ml` (is_ready) — P3 #13 ducker.
