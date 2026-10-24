# Najboljše pripravljene skripte na GitHubu: samodejne oddaje, prehodi govor↔glasba, napovedovanje

*Datum: 2026-10-24 · **v2 (druga iteracija: hipoteza → iskanje → verifikacija → matrika)** · Radio Clyde main `a1c1fee`, Liquidsoap 2.2.4-1+dev*

Naloga: najti **že pripravljene** skripte z največ funkcijami za (1) samodejno generiranje oddaj, (2) prehode med govorom in glasbo, (3) napovedovanje (ID-ji, časniki, vreme/novice). Vsak nosilec je ocenjen po: dokaz v produkciji, determinističnost, prileganje naši arhitekturi (Node piše m3u + annotate → Liquidsoap mixa), licenca, cena integracije. Na koncu sta urejena matrika primerjave in predlog integracije.

---

## 0. Metodologija in hipoteza (novo v v2)

Vrstni red po nalogu: **najprej razmislek, potem iskanje, nato verifikacija iz primarnih virov** (raw GitHub, uradna dokumentacija, razprave maintainerjev). Hipoteza zapisana PRED iskanjem, z oceno po dejstvih:

| # | Hipoteza (pred iskanjem) | Sodba po verifikaciji |
|---|---|---|
| H1 | TTS→oddaja gre povsod prek `request.dynamic` + začasna datoteka; profesionalni sloj je normalizacija glasnosti (R128) | **Potrjeno, delno:** `request.dynamic` je uradna pot (cookbook); R128 ne pride kot ločen korak, ampak prek annotate `liq_amplify` (autocue / AzuraCast #6252) |
| H2 | Prehodi govor↔glasba imajo le 4 kanonične vzorce: trd rez z cue, crossfade ovojnica, ducking podlaga, jingle overlay | **Potrjeno in razširjeno:** 5. kanonični vzorec je **dispatch po oznaki vira** (`source_tag`) — uradni cookbook ga zapiše dobesedno; generalizira naš annotate »0« model |
| H3 | Generatorje oddaj vodijo rotacijska pravila (`rotate(weights)`, `switch({{0m}})`, `delay()`); deterministični razporejevalniki so redki | **Potrjeno:** vsi trije vzorci uradni; format ura obstaja kot AzuraCast »Clockwheel/Playlist Groups« (PR #8433); edini čisto deterministični Node generator = defenestratexp |
| H4 | Napovedovanje = predloga + podatkovni vir (vreme/novice) → TTS | **Potrjeno** (WRIT-FM taksonomija, defenestratexp predloge, Rivendell RDCatch); **novo odkritje:** `predicate.activates` rešuje »natančno ENA napoved na okno« — v1 vzorec z golo `switch` je imel to napako |
| H5 | Novih pun repozitorijev bo malo; vrednost je v verificiranih uradnih vzorcih | **Potrjeno:** nič novih glavnih kandidatov; nove pridobitve so drobci — EBU meta-indeks, Piper naslednik, Clockwheel dizajn, 8 uradnih receptov 2.2.5 dobesedno |

Kaj je v v2 novo iskano in najdeno: meta-indeksi (EBU), status Piper runtime (arhiviran → naslednik), format ure pri AzuraCastu (kljub priloženi razpravi #8432 do konca), uradni cookbook 2.2.5 (verificirane kodo-vrstice), gist z `smooth_add`.

## 1. Naša izhodiščna točka (iskrena samopodoba)

`liquidsoap/radio.liq` (131 vrstic) je danes minimalen: `playlist(now_playing.m3u, watch)` → `fade.in` z annotate `liq_fade_in` (skladbe se zavejo, govor dobi »0« = trd rez) → `fallback(track_sensitive=false, [show_source, filler_source])` + `mksafe` → en MP3 Icecast mount. Ključna zgodovina: `crossfade()` je že **dvakrat spodletel** (obrezal je živ govor DJ-ja; global `fade.out` v tej verziji utiša celo skladbo), zato so prehodi rešeni z vnaprej renderiranim fade-out (samo jingle) in trdim rezom povsod drugje. To je varno, a zveni »digitalno«. Prav ta bolečina je v svetu Liquidsoapa že dvakrat rešena — spodaj.

## 2. Prehodi govor↔glasba — uvrstitev

### 2.1 Zmagovalec: autocue (Moonbase59, MIT) — in je že VGRADJEN v Liquidsoap

Repo: `https://github.com/Moonbase59/autocue` (51★, MIT, 225 commitov, zadnja aktivnost 2024-10). Dela: `cue_file` (Python3 + ffmpeg ebur128 + Mutagen) analizira vsako datoteko in vrne JSON: `liq_cue_in`, `liq_cue_out`, `liq_cross_start_next`, `liq_fade_in/out`, **`liq_amplify` (R128 glasnost → dB korekcija)**, `liq_longtail`, `liq_sustained_ending`, true peak, blankskip. Integracija: protokol `autocue:` (`%include autocue.cue_file.liq`) ali **od 2.2.5 vgrajeno**: `enable_autocue_metadata()` — ena vrstica (notranja implementacija, samo ffmpeg povezave).

Zakaj je to točno naš primer: (a) narejen za LS **2.2.5** (mi: 2.2.4 — ena minor verzija; pri 2.3.x imajo težave, ne obratno); (b) vgrajen v AzuraCast od 2024-05; (c) **ne prekriva virov** — oblikuje ovojnico posamezne datoteke (cue/fade/loudness), torej ne trpi problema, ki je ubil naš `crossfade()`; (d) R128 normalizacija je pravi mehanizem za »nivojsko poravnane« meje govor↔glasba, ki jih trenutno dosegamo le s statičnimi ugibi; (e) podpira predobdelavo z oznakami (»za dramatično hitrost«) — naš Node scheduler lahko analizira enkrat, offline.

Opozorila, dobesedno iz README: »Ne uporabljajte blankskip s govorjenim ali TTS-generiranim besedilom — pogosto odreže sporočilo« (naš govor ima lastno pot z annotate »0«, tako da varno); »Pred spreminjanjem nastavitev točno vedite, kaj počnete«. Privzete nastavitve (za našo dokumentacijo): fade_in 0,1 s, fade_out 2,5 s, cilj −18 LUFS, tišina −42 LU, overlay −8 LU, longtail 15 s.

### 2.2 AzuraCast »Profesionalni Crossfade« (nit #6252, Moonbase59) — radijski standard v številkah

Vir: `github.com/AzuraCast/AzuraCast/discussions/6252` (127 komentarjev; rojstni list autocue). Kostni izvleček, vreden zapisa v našo dokumentacijo: »V radiu navadno NE uporabljamo fade-inov«; radijski standard: **fade_in = 0 s, fade_out = 3,5 s, začetek fade-out pri −15 dB (EBU R128), največji preklop 4,0 s, okno računanja moči 2,0 s**; priporočljiva kombinacija: `amplify(1., override="replaygain_track_gain", radio)` pred `cross()` in `cross.simple(old, new, fade_in=0.00, fade_out=3.50)` znotraj `cross(minimum=0.00, duration=4.00, width=2.00, …)`; izrek avtorja: **»Ne uporabljajte cross.smart, ker ni tako pameten«** (pravila po dB povprečjih so pregroba). Podatkovna pot: AzuraCast od LS 2.2.x pošilja **annotate na vsako skladbo** (`liq_fade_in`, `liq_fade_out`, `liq_cue_in/out`, `liq_amplify`) in se zanaša na samodejno ponastavljanje oznak — točno isti model, ki ga že uporablja naš director (`annotate:liq_fade_in=…` v m3u). To pomeni: naša arhitektura je že na pravi poti, manjka le **realna analiza** za vrednosti namesto ugibov.

### 2.3 SUB/WAVE `radio.liq` (MIT, 2.324 vrstic) — najbogatejši enoten primer, a zahteva nov Liquidsoap

Vir: `raw.githubusercontent.com/perminder-klair/subwave/main/liquidsoap/radio.liq`. Izvlečki, vredni učenja ne glede na različico: (a) **±6 dB invarianta preklopa** — »fade.out/fade.in morata segati čez CEL cross buffer, sicer izhodna ostane na polni glasnosti ob prilivanju prihajajoče: +6 dB, čuten podvajanj«; (b) **cross žigi** — en liq_cross_duration na skladbo se prepiše v ločena start/end žiga, ker `cross` sicer velikost izhodnega repa velikosti po oznaki PREJŠNJE skladbe (izmerjeno: 3.931/3.997 prehodov); (c) `cue_cut` za trdne omejitve dolžine; (d) **dead-air stražar**: `fallback([music, emergency])` s 30 s rožnatim šumom + `music-starved.json` srčni utrip; (e) `request.queue` polnjen iz `next.txt` (poll 1 s) — mehanizem vstavljanja brez reload; (f) `subhttp` protokol, ki **zavrača JSON/XML body kot »ne-zvok«** (Navidrome vrne 200 z napako!) in <4 KiB datoteke; (g) runtime nastavitve prek besedilnih datotek. **Ključna ovira, dobesedno iz datoteke:** »v2.4.6 je NAJMANJŠI runtime; 2.4.4 O(n) clock scan zasede jedro, 2.4.5 odvrne delni okvir po vsakem cross« — torej SUB/WAVE-jevi efekti (chop/washout/dissolve) so za nas šele po nadgradnji na 2.4.6+. To je projekt P3, ne današnja izposoja.

### 2.4 uradni `cross.smart` (dok. Liquidsoap 2.2.5) — vzemite kot učbenik, ne kot rešitev

Vir: `liquidsoap.info/doc-2.2.5/crossfade`. Javna koda (dB-pravila: medium −32, high −15, margin 4 dB → izbere full-cross/fade-out/fade-in/no-fade/default). Uporabna kot referenčna taksonomija prehodov; v praksi odsvetovana (2.2). Ničesar ne uvajamo.

### 2.5 NOVO: `source_tag` dispatch — kanonični vzorec za govor vs glasba (uradni cookbook 2.2.5)

Vir: `liquidsoap.info/doc-2.2.5/cookbook`, dobesedno. Vsak vir dobi oznako, prehod pa se odloči po njej:

```liquidsoap
def source_tag(s, tag) = ... metadata.map(id=tag, insert_missing=true, f, s) end
music   = source_tag(<glasba>, "music")
jingles = source_tag(<jingli>, "jingles")
radio   = rotate(weights = [1, 3], [jingles, music])
# Če katerikoli rob NI glasba → trd rez (sequence); sicer standardni preklop:
def transition(a, b)
  if a.metadata["source_tag"] != "music" or b.metadata["source_tag"] != "music" then
    sequence([a.source, b.source])
  else
    cross.smart(a, b)
  end
end
radio = cross(duration=5., transition, radio)
```

*(V publikaciji stoji pogoj z `a.` v obeh krakih — očitna tipkarska napaka; namen je »če KATERIKOLI vir ni glasba«, kot zgoraj popravljen. `cross.smart` znotraj vzorca je le ilustracija — v praksi nadomestimo z našo annotate enačbo.)*

To je **generalizacija našega modela**: namesto implicitnega »govor ima annotate 0« explicitno označimo vire in razdelimo pravila. Naš Node writer že poznajo `dj` polje, torej je cena nizka: ena meta oznaka v m3u + ena funkcija v `radio.liq`. Prednost: prehod glasba→jingel→glasba postane enolično določen v enem mestu, namesto razpršenega po annotate vrednostih.

**Status (2026-10-24): Node polovica IMPLEMENTIRANA, LS polovica čaka live verifikacijo.**
Vsi m3u vnosi, ki jih piše repo, nosijo točno eno `source_tag` oznako — pogodbo pina `test/sourceTag.test.mjs`:

| Vir | Oznaka | Piše |
|---|---|---|
| glasbene skladbe (show + filler) | `music` | `director/playlist.js` annotateTrackEntry |
| DJ govor | `speech` | `director/playlist.js` annotateSpeechEntry |
| oddajni jingle | `jingle` | `director/playlist.js` annotateJingleEntry (od zdaj VEDNO annotate vrstica, tudi brez title/station) |
| ID ob polni uri | `id` | `scheduler/imagingPlaylists.js` (per-layer) |
| stingeri | `stinger` | isti |
| nujna podlaga | `emergency` | isti |

Iskreni obseg: na 2.2.4 **nič ne bere** `source_tag` (kot liq_cue polja) — vrednost je samoopisen m3u in priprava, da bo LS polovica čisti potrošnik že obstoječih podatkov.

**LS polovica — recept za radio.liq, OBVEZNA live verifikacija pred zrakom** (radio.liq zgodovina: crossfade() je dvakrat spodletel; pravilo »ne lovi parametrov znova, spremeni strukturo« je ravno tu):

```liquidsoap
# SAMO okoli programskega jedra (show+filler), NIKOLI okoli ID overlay-a
core = fallback(track_sensitive=false, [show_source, filler_source])
def dispatch(a, b)
  if a.metadata["source_tag"] != "music" or b.metadata["source_tag"] != "music" then
    sequence([a.source, b.source])   # govor/jingle/ID/stinger: trd rez = današnje vedenje
  else
    add([fade.initial(2., b.source), a.source])  # glasba→glasba: nov pride čez rep starega
  end
end
core = cross(duration=4., dispatch, core)
radio = fallback(track_sensitive=true, [stinger_timed, core])  # ← preveriti interakcijo!
```

Trije znani tveganji, ki jih NI mogoče verificirati brez poslušanja: (a) **stinger meja** — `fallback(track_sensitive=true)` lahko opazuje mejo na CROSS točki (do 4 s pred realnim koncem skladbe) in bi rezal rep starega skladbe; če se pokaže, se stinger sloj preseli znotraj/outside cross drugače ali pa cross pride samo na filler; (b) **ID overlay** ne sme biti znotraj cross() (rez na :00 bi pokvaril overlay semantiko — ID prične takoj, ne na meji); (c) cross() poveča zakasnitev ob meji za dolžino okna (buffering). Verifikacijski koraki: `liquidsoap --check`, poslušanje 3–5 realnih meja DJ↔skladba na boxu, šele potem commit na produkcijo.

### 2.6 NOVO: `smooth_add` — napoved ČEZ glasbo brez sidechaina (vzorčni gist)

Vir: gist `9ebb70312419427cdb42a7170993faa6` (»Liquidsoap Radio System«), dobesedno:

```liquidsoap
radio = smooth_add(delay=0.8, p=background_volume, normal=radio, special=microphone)
# Make quick announcements on the fly with this.
```

`smooth_add` je uradni operator: `special` utiša `normal` na `p` (delež glasnosti) brez ffmpeg sidechaina, z `delay` pripravi mehko mejo. Za nas zanimivo za P3 »postelje« — bolj preprosto kot radio-dj-jev `sidechaincompress`, brez dodatnega procesa, deluje na 2.2.x. Omejitev: zahteva STROJNO ločena vira (special = govor), naš tok je ena m3u — torej šele po prehodu na `request.queue` vstavljanje (P2 #6).

> **STATUS — IMPLEMENTIRANO (P3 #12, 2026-10-24).** Postelje v zraku: `radio.liq` meša `request.queue(id="beds")` čez program z **vgrajenim** `smooth_add` — preverjeno v tar 2.2.4 (`src/libs/extra/audio.liq`, vrstice 371–408 + regresijski test `tests/regression/115-2.liq`): medtem ko je v vrsti klip, normal utihne 1.0 → p (privzeto 0.2) prek `mkfade` v ~duration (privzeto 1 s), special pa se pojavi na `1-p` — vsota amplitud ostaja ~1.0, BREZ sidechain procesa; notranji `fallback(track_sensitive=false, [special, blank()])` pomeni, da potisnjen klip zaide TAKOJ, sredi skladbe (točno to je bistvo postelje), ob koncu isti fade teče nazaj. Bistveni odklon od gista: gist je zgodnja ročna varianta z `~delay`, 2.2.4 že IMA operator v stdlib — uporabimo vgrajenega (brez vdelane kopije, sicer bi se ob spremembi builda tiho forknil), parametra `duration=1.`/`p=0.2` sta dobesedna literala (isti politik kot interval stingerjev: json.parse tip nedotaknjen, starejši config še vedno zažene). Vodni sloj: `beds_source` podeduje P2 #8 stroj (`beds.push <pot>` → številski id, `beds.queue` → id-ji, `beds.skip` → »Done.« — vse verificirano v tar `src/libs/request.liq`; Node polovica `src/liquidsoap/bedQueue.js` z CLI push/queue/skip). Postavitev: NAD ID overlayjem in zahtevki (napoved prekaša vse glasbeno, tudi poslušalčev zahtevek), POD programskim dead-air opazovalcem — opazovalci vidijo MEŠANICO (isti razlog kot ID overlay nad njimi): klip čez tiho programsko verigo je slišan radio, ne mrli zrak; epizoda se zapiše šele, če tišina preživi tudi klip. Iskrene opombe: beda NI scrobblana (govor, ne glasba), `liq_amplify` nanjo ne deluje (gola pot brez annotate), samodejna pot »vreme kot postelja iz produkcije« je ločena prihodnja odločitev — danes potiska operater prek CLI-ja s produciranim klipom. Testi: `test/bedQueue.test.mjs` (10: ožičenje radio.liq po vrstnem redu, vgrajen operator brez inline kopije, lažni telnet strežnik z realnim protokolom za push/queue/skip, pot s presledki, relativna pot → absolutna, manjkajoča datoteka = napaka brez klica). npm test 248/248. Živa verifikacija na boxu (pred zrakom, kot vedno): `liquidsoap --check radio.liq`, potem `node src/liquidsoap/bedQueue.js push <klip.wav>` in poslušanje: glasba utiha, govor pride čez, po koncu nazaj — `--check` je tudi edina preverba, da `smooth_add` obstaja v boxovem buildu (2.2.4-1+dev; v tar 2.2.4 je, `@flag extra` libs so del standardne namestitve). Reverzibilno: izbriši dve vrstici v radio.liq.

## 3. Napovedovanje — uradni vzorci (canonical answer), v2 dobesedno verificirani

Vir: `liquidsoap.info/doc-2.2.5/cookbook` + `doc-2.4.5/complete_case`. Vsi naslednji izvlečki so prebrani iz primarne strani v tej iteraciji:

```liquidsoap
# (1) Jingle vsakih ~3-5 skladb — uradni vzorec (rotate):
radio = rotate(weights = [1, 3], [jingles, music])

# (2) ID postaje na polni uri, zmešan NAD programom (brez prekinitve):
radio = add([normal, switch([({0m0s}, jingle)])])

# (3) NOVO — natančno ENA napoved v prvih 5 minutah ure (popravek v1 vzorca!):
#     goli switch({0m-5m}) bi lahko odigral VEČ jinglov; predicate.activates
#     zazna trenutek, ko predikat postane resničen, in odigra natanko enega:
radio = switch([(predicate.activates({0m-5m}), jingles), ({true}, playlist)])

# (4) Periodni imaging (uradni recept »Periodic playlists«):
timed_promotions = delay(1200., promotions)   # vsakih 20 min
main_source = fallback([timed_promotions, other_source])

# (5) Stražar pred tišino (uradni recept, blank.strip):
stripped_stream = blank.strip(<vir>)
fallback(track_sensitive=false, [stripped_stream, blank.strip(normal)])
```

Naš primer: obstoječi pre-renderirani jingle + novi ID-ji (Piper, enkratna proizvodnja) — nič novega v Node, čista `radio.liq` sprememba, enostavno reverzibilna. Za ID ob polni uri uporabimo **(2) overlay** (ID nad pesmijo, kot pravi radio) ali **(3) predicate.activates** (ID med skladbama); (4) reši P1 #3 imaging sloj (stingeri vs. 20–30 min), (5) je uradna varianta našega P2 #7 dead-air stražarja.

> **STATUS (5) — IMPLEMENTIRANO (P2 #9, 2026-10-24).** Emergency podlaga (nujni vir) je bila vgrajena že v imaging sloju (docs/imaging-layer.md); ta korak je dodal manjkajočo polovico — lov tišine, ki jo vir *dejansko proizvaja* (pokvarjen/tih encode ostane "available" in bi igral tišino do konca datoteke). Verifikacija iz PRIMARNEGA vira tega builda (v2.2.4 `src/core/operators/noblank.ml`): `blank.strip` = "Make the source unavailable when it is streaming blank" (`_is_ready = (not is_blank) && source#is_ready` — availability se širi skozi `fallback`); tišina se **akumulira** — `max_blank=20.` (privzeto, ohranjeno eksplicitno) pomeni 20 s toleranco pred preklopom, tako da mikro-pavze na mejah in producirane pavze v govoru nikoli ne sprožijo; `min_noise=0.` = takojšnja vrnitev ob zvoku; `track_sensitive=true` = reset števca na vsaki track meji (vsaka nova datoteka dobi novo priložnost). Odklon od recepta (dokumentiran): strip sedi nad **celotnim** programskim sklopom (show+filler, requests, stingeri, ID overlay) pred `amplify` — sodi po zvoku kot produciranem, per-track korekcija ne more potisnite tihega masterja pod prag; nujni vir ostane NE-stripan (mksafe čisti blank ostane iskrena zadnja mreža). Poraba: dva opazovalca `blank.detect` (isti state machine, pasivna) — programski sloj ("stražar je deloval") in zračni sloj nad mksafe (`track_sensitive=false`, absolutna meritev — pomeni "odpovedal je tudi nujni vir"); robovi pišejo ledger `dataDir/history/deadair.jsonl` prek ozadjenega `src/deadair/recordEvent.js` (isti vzorec kot scrobble handler), Diagnostics parira epizode (`src/deadair/ledger.js`). Debounce NI potreben v Node: detect fires samo na prehodih akumulatorja (≥20 s tišine). Parametri so literali (imaging vzorec — json.parse tip nedotaknjen, starejši config še vedno zažene). Reverzibilno: izbriši tri vrstice + štiri handlerje. LIVE verifikacija na boxu OBVEZNA pred zrakom: `liquidsoap --check radio.liq`, umetno tih WAV v now_playing.m3u → poslušaj prehod na emergency bed pri ~20 s + preveri `deadair.jsonl`.

## 4. Samodejna generacija oddaj — uvrstitev

### 4.1 defenestratexp/liquidsoap-icecast-radio (MIT) — arhitekturni dvojček

Repo: `github.com/defenestratexp/liquidsoap-icecast-radio` (0★, sveže 2026-09, Ansible, MIT). Pomembnost ni v zvezdicah, temveč v tem, da je **edini najdeni projekt z identično filozofijo**: fiksni predlogni tekstri + Piper TTS + žanrski sporedi + play log, brez LLM. Njegov DJ tok: Liquidsoap vsakih 5 skladb zapiše oznake zadnjih treh skladb v datoteko → `dj-announce.sh` napolni fiksne predloge (»From the album X by Y, that was Z … Next up …«) → Piper → ffmpeg 44,1 kHz/128k MP3 → **`request.queue`** predvaja med skladbami. Izposojljivo konkretno: (a) pravila pametnega plejlista — deduplikacija po (izvajalec, naslov), **omejitve 30 skladb/izvajalec in 5/(izvajalec, album)** (kompilacije ne preplavijo sporeda), izključitev vseh predvajanih v zadnjih 12 h, **utež po 7-dnevnem števcu vrtenc** (manj predvajane pridejo prej), boost novosti (7 dni); (b) `audit-show-playlists.sh` — poročilo skladb z napačnim žanrom v sporedu (določena vsebina za naš Diagnostics); (c) `radio-manifest.json.j2` + `radio-sw.js.j2` — PWA datoteke (že izposojeno v P1); (d) naslednja skladba prek telnet `music.next` + ffprobe za »Next up« besedilo — deterministična nadgradnja našega liveLines predlog.

**Status (2026-10-24): pravila rotacije IMPLEMENTIRANA (P2 #6) — rotacijska plast (filler).**
Nova enota `scheduler/rotationRules.js`; integracija v `generateFillerPlaylist.js`; pogodbo pina `test/rotationRules.test.mjs` (14 testov: čista matematika, realni ledgarji na disku, e2e z realnimi WAV). Pet pravil in kam so pristala:

| defenestratexp pravilo | Stanje pri nas |
|---|---|
| dedup po (izvajalec, naslov) | **že pokrito, strožje:** obstoječi `dedupeByTitle` zbije iste naslove postajno (tudi priredbe) — »ista pesem« ne more v bazen niti pod drugim kataloškim vnosom |
| izključitev vseh predvajanih 12 h | **že preseženo:** filler ledgar izključuje `rotationWindowHours` (24 h), show zgodovina `shows.repeatWindowDays` (30 dni) |
| 30 skladb/izvajalec na playlisto | **NOVO:** `capPerArtist` (vnosni vrstni red = prioriteta; neznani izvajalec = svoja skupina) |
| 5/(izvajalec, album) na playlisto | **NOVO:** `capPerArtistAlbum` (brez albuma = nikoli obrezano, kot `oneTrackPerAlbum`) |
| uteži po 7-dnevnem števcu + boost novosti | **NOVO:** `stationPlayCounts` (združi played.jsonl + filler ledgar — eno števce za celo postajo), `weightedRotationOrder` (Efraimidis–Spirakis, utež 1/(1+števec) — manj predvajana pride prej), novelty ×3 za sledi dodane v 7 dneh (Plex `addedAt` / lokalni mtime) |

Iskreni obseg: pravila veljajo za **rotacijsko plast** (filler), ne za kurirane show-e — ti vsiljujejo raznolikost strukturno (`repeatArtist`, `oneTrackPerAlbum`, artist cooldown), zato so namenoma izven obsega. Backfill pri majhnih knjižnicah **namerno obide caps** (poln bazen premaga vsiljen cap — ista filozofija kot artist-cooldown bypass v `buildTrackQueue`). Vsi gumbi v `config.filler.rotation`; manjkajoč blok = delujoče privzete vrednosti; posamezno pravilo se izklopi z 0 (`weightWindowDays: 0` = točno današnji plain shuffle).

### 4.2 WRIT-FM (382★, MIT) — struktura je deterministična, vsebina AI (preverjeno)

Repo: `github.com/keltokhy/writ-fm`. Vsebinski generator je LLM (Claude/Kodex) + Kokoro/Chatterbox/Voxtral; **struktura pa je vredna kopiranja tudi nam**: taksonomija segmentov (deep_dive, news_analysis iz RSS, interview, panel, story, **listener_mailbag**, music_essay + kratke: **station_id, show_intro, show_outro** kot prvovrstni vsebinski tipi), tedenski premik (nedeljski »Listener Hours«), **min-zaloga** (≥3 govorni prekini/slot, ≥20 skladb/oddaja — zdravstveno merilo), station-local topic bank + append-only **uredniški vodnik** (kontinuiteta med oddajami), več-stancijska izolacija (WRIT/KLOD/CDEX iz enega runtime). Za nas: tipi segmentov se 1:1 prevedejo v naše template vrste (liveLines + prewarmed slots), min-zaloga pa v Diagnostics »vsebina pripravljena za naslednji slot«.

**Status: IMPLEMENTIRANA (P2 #7).** `src/script/segments.js` (taksonomija + merilo), `segment:` polje v `script/format.js`, `src/server/inventoryUtil.js` + blok `inventory` v `/api/diagnostics`. Preslikava:

| WRIT-FM koncept | Naša implementacija |
|---|---|
| taksonomija tipov (prvorazredni show_intro/outro, mailbag, ...) | **zaprt niz 13 tipov** `SEGMENT_TYPES`: show_intro, show_outro, track_intro, quiz, news_analysis, weather_check, listener_mailbag, deep_dive, story, music_essay, interview, panel, banter; station_id NI tip skripte — lasti ga imaging sloj (imaging/id.m3u) |
| tipi kot prvovrstni podatki | neobvezno `segment:` polje na dj/live segmentih v script.md (validacija proti zaprtemu nizu — neznana oznaka = napaka parse-a); renderScript ga zapiše nazaj (round-trip) |
| (WRIT jih zapiše ročno) | **inferenca** iz slot/pozicije: open/close → show_intro/outro, intro/recap → track_intro, quiz* → quiz, rubrike (newsHeadlines/sportHeadlines/obzorje) → news_analysis, weatherNow + vse `type: live` → weather_check, handoff/neznano → banter; brez oznake se vsaka obstoječa skripta klasificira nespremenjena |
| explicit-only tipi | listener_mailbag, deep_dive, story, music_essay, interview, panel — nič v današnji strukturi jih ne nakazuje, zato se NIKOLI ne uganejo; postanejo resnični z oznako |
| min-zaloga: ≥3 govorni prekini/slot, ≥20 skladb/oddaja | `segmentInventory()`: ≥`shows.inventory.minSpeechSegments` (privzeto 3, ravno) govorih + ≥`minTracksPer30Minutes` (privzeto 6 — WRIT 20/uro skalirano na našo knjižnico 3.5–5 min) na 30 min trajanja (ceil); MERILO SAMO POROČA — nikoli ne blokira parse-a ali produkcije (blocking pogodba ostaja parseScript) |
| Diagnostics »vsebina pripravljena za naslednji slot« | `/api/diagnostics` blok `inventory`: za vsako od 5 prihajajočih obratov — script.md obstaja? se parse-a? izpolnjuje minima? `ready` = en-gled-odgovor operatorja, vsak izpad z točnimi številami |
| tedenski premik (Listener Hours), topic bank, uredniški vodnik, več-stancijska izolacija | NI v1 — spodaj P3, takrat ob dotiku arhitekture produkcije |

### 4.3 radio-dj (60★, MIT, Go 8,7 MB) — drobci

Veščine kot **urejanje besedilnih datotek** (`~/.radio-dj/skills/`, brez prevajanja), `radio-dj install` (ustvari systemd/launchd/OpenRC enoto), ffmpeg **sidechaincompress** ducking (DJ govor čez glasbo — pri nas trenutno nič, ker naš govor nikoli ne teče čez glasbo; zanimivo za prihodnje »postelje«, poenostavljena uradna alternativa je 2.6 `smooth_add`), PWA UI z DJ dnevnikom. Jedro je LLM direktor — ostalo je mehanika.

### 4.4 LibreTime Smart Blocks + Rivendell — modeli pravil

LibreTime (AGPL): kriterijski bloki (»12 ambient skladb < 6 min«) — polje/kriteriji/operaterji so prenesljivi v naš rules.js kot »deterministični Smart Block«. Rivendell: RDCatch planirani snemalnik (vzorec za samodejne vremenske/novičarske prevzeme v fiksne ure) — koncept, ne koda.

> **STATUS — IMPLEMENTIRANO (P3 #14, 2026-10-24).** Deterministični Smart Blocki v `src/producer/smartBlocks.js`: imenovani bloki v `config.smartBlocks` (kriteriji + limit + order) se razširijo v konkretno seznam skladb na zahtevo. Verifikacija iz PRIMARNEGA vira (libretime.org/docs »Playlists and smart blocks«): limit **hours/minutes/items** (naš {count} = items, {minutes} = minutes), privzeto **brez prelivanja** (skladba, ki bi prečila limit, ostane ven — `overflow: true` = njihova opcija »Allow last track to exceed time limit«), vrstni red **random/newest/oldest** (+ naša razširitev **sequential** (abecedno) in **popular** (uteženi shuffle)), privzeto **brez ponovitev** — mi strožje: ISTA veriga upravičenosti kot vse ostalo (dedupeByTitle, postajno izključitev predvajanih, neverPlay prepovedi, trajanje). Odklon (dokumentiran): NE prevzemamo LibreTimeove matrike operatorjev (contains/starts with/greater than/in range) — besednjak kriterijev je obstoječi zaprti niz buildTrackQueue (artist, artistList, genre, decade, albumKeyword, albumGenre, folder, recentlyAdded, excludeKeywords, max/minTrackDurationSeconds), ker drug dialekt bi forknil pravila upravičenosti; neznan ključ = napaka s seznamom dovoljenih (zaprt niz, kot segment: validacija). Bloki so vedno DYNAMIC (razširitev ob produkciji, zamrznjena v preproduced epizodi). Sevm: brief vrstica `- smart block: <ime>` (ali `- pametni blok:`) v »## Track Selection« — blok JE izbira (prose kriteriji ob njem se ignorirajo); produce.js razširi blok BREZ auto pravil (cooldown/popularShare/decadeSpread ne prepišejo kurirane enote) z ISTO verigo upravičenosti spodaj; `neverPlayBans` je zdaj export iz queue.js (en vir pravila združitve prepovedi). Poraba: `src/cli/previewSmartBlock.js <ime>` (»kaj bo ta blok predvajal ZDAJ?«), studio `GET /api/smart-blocks` + `GET /api/smart-blocks/:name/preview`, config.example.json primer. Iskreno poročanje: shortfall (bazen ne more zapolniti limita) in limitNote (no-overflow prekinitev po zasnovi) sta ločena izida, nikoli tiha krajšava. Reverzibilno: brez config bloka funkcija ne obstaja.

### 4.5 NOVO: AzuraCast Clockwheel → Playlist Groups (PR #8433) — format ura kot profesionalni model

Vir: `github.com/AzuraCast/AzuraCast/discussions/8432` (prebrana do konca, vključno z odzivom maintainerjev). Problem, ki ga rešujejo, je *isti kot naš*: uteži + naključje ne dajejo deterministične kontrole, ki jo pravi radio ima. Dizajn (poenoteno v Vaalynov PR #8433, RM-FM #8434 zaprt): **seznam korakov, vsak korak kaže na obstoječi plejlist** (primer: Glasba A → Glasba B → Jingle → Glasba A → Postajni ID → ponovi); AutoDJ sledi korakom po vrsti, na vsakem koraku poteče N skladb iz otroka (spoštuje njegovo naključno/vrstno vedenje), na koncu zank; koraki lahko dovolijo **prevzem s poslušalčevim zahtevkom** ali so prazni namenski sloti; otroci so med delovanjem **umaknjeni iz splošne rotacije**; podpora za **del dneva** (dayparts); vsak odigran track v »Song Playback Timeline« pokaže vijolično značko, kateri clockwheel in korak ga je čakal. Odziv skupnosti: močno pozitiven (»uporabniki so odšli ravno zaradi tega«). Za nas: to je **izvedljiv načrt za P2 »format ura«** — naš Node scheduler že zna pisati m3u, torej clockwheel = majhna podatkovna struktura (krožni seznam (plejlist, N) korakov) + eno pravilo v pridobivanju naslednje skladbe. Opomba: eden od komentatorjev (eternityready2) pokaže lastno različico z **AI newscasterjem/DJ-jem** — zavržemo (arhitektura brez LLM).

**Status: IMPLEMENTIRANA (P2 #10).** `src/scheduler/clockwheel.js` + integracija v `generateFillerPlaylist.js`. Preslikava AzuraCast dizajna na našo arhitekturo:

| AzuraCast koncept | Naša implementacija |
|---|---|
| Playlist Groups (otroci) | imenovani **pools**: `filler.clockwheel.pools` z filtri `artists` / `genres` / `keywords` / `excludeKeywords` (AND med polji, OR znotraj polja; fold diakritik kot povsod) nad isto `eligible` množico kot današnji filler |
| »children removed from general rotation« | `splitPools()`: vsak track pade v PRVI urejevali pool (vrstni red v configu = prioriteta); neusvojeno ostane v rezerviranem poolu `rotation` — izsvojen track nikoli ne pride ven |
| koraki → plejlisti, N skladb/korak | `steps: [{pool, count}]` krožno; `walkWheel()` porablja pool čakalni vrsti (shift) — znotraj ene regeneracije se track ne ponovi, dokler njegov pool ni izčrpan |
| dayparts | `dayparts: [{from, to, steps}]` — PRVI okno, ki vsebuje trenutno minuto (od inkluzivno, do ekskluzivno); v1 brez preloma čez polnoč (noč = dve okni: 00:00–05:00 in 23:00–24:00); brez zadetka = privzeti `steps` |
| koraki z dovoljenim prevzemom zahtevka | **preseženo s P2 #8**: `request.queue` prevzame NA vsaki meji skladbe nad vsem programom — kolo ne rabi rezervirati slotov |
| Song Playback Timeline vijolične značke | NI v1 (ni operator UI-časa); iskren nadomestek = log vrstica vsake regeneracije (kateri daypart, izpisi po poolih) |
| children imajo svoje random/vrstno vedenje | vsak pool gre skozi ISTO rotacijsko verigo (uteži 7-dnov + novelty + caps) — caps vežejo znotraj poola, tako da eno-izvajalčev pool ni obglavljen |

LS polovica (verificirano iz tar 2.2.4 `src/libs/playlist.liq`, vrstice 173–176, 190–196, 227–239, 247–253): veljavni načini so točno `normal` / `random` / `randomize`; `randomize` meša ob nalaganju, ob vsakem watch reloadu IN ob vsaki zanki — torej kolo sliši le z `mode="normal"` na filler playlisti (ena beseda, pripravljena vrstica v komentarju nad `filler_source` v radio.liq). Z `normal` zapisani vrstni red igra točno tak, kot je zapisan; vsaka regeneracija zamenja vrstni red na naslednji meji skladbe. Privzeto repo pusti `randomize` (box brez kola se ne spremeni), `runClockwheel()` pa vsako regeneracijo zapiše opomnik o preklopu. Degradacija: brez `filler.clockwheel` bloka = točno današnje vedenje; neveljavni vnosi se izpustijo in preštejejo v logu; suh pool da manj, kolo hodi naprej; popolnoma suho kolo pade v isti ledger-oldest backfill kot gladka pot. Reverzibilno: izbriši blok.

### 4.6 NOVO: EBU awesome-broadcasting (1,8k★) — meta-indeks, pokrajina potrjena

Vir: `github.com/ebu/awesome-broadcasting` (kurira EBU, evropska zveza javnih radijev). Pregled sekcij play-out/razporejanje/avdio: Rivendell, OpenBroadcaster, Airtime/LibreTime, AzuraCast, Liquidsoap, SoX/FFmpeg/GStreamer; razporejanje: OnTime (pregled radijske ure). **Ni skritega biseru za naš ozki problem** — kar potrjuje, da je v1 pokrajina popolna in da je Liquidsoap prva izbira: njegova domača stran izrecno navede Radio France s 77 postajami ter AzuraCast in LibreTime kot playout motorje. TTS sekcije v indeksu ni — potrjuje, da je TTS-napovedovanje v radijskem svetu redkost, ne standard.

### 4.7 NOVO: status Piper runtime — arhiviran, naslednik aktiven

Dejstva preverjena v tej iteraciji: `rhasspy/piper` je **6. 10. 2025 arhiviran** (read-only; 11,3k★, MIT). Aktivni naslednik je **`OHF-Voice/piper1-gpl`** (5,9k★, **GPL-3.0-or-later**, v1.8.0 z 4. 9. 2026, pod okriljem Open Home Foundation; `pip install piper-tts`; CLI/web/Python/C++ vmesniki; fonemizacija prek espeak-ng). Slovenščina obstaja kot glas v piper-samples katalogu (filter »Slovenščina«). Vpliv na nas: (a) če uporabljamo Piper binarne datoteke, so zamrznjene na stari verziji — pri naslednjem dotiku TTS načrtujemo prehod na piper1-gpl; (b) sprememba licence MIT→GPL **ne vpliva** na klic CLI-ja iz Node (proces), ampak samo na vdelavo/predelavo kode; (c) Edge TTS pot je neodvisna od tega. Vir: `github.com/OHF-voice/piper1-gpl`, promptquorum pregled (primerjava obeh repozitorijev), `rhasspy.github.io/piper-samples`.

> **STATUS — IMPLEMENTIRANO (P3 #15, 2026-10-24).** Piper sloj prešel na **piper1-gpl** (`piper-tts` 1.8.0 s PyPI), en sam vir resnice za vse tri klicne točke: novi `src/auto/piperVoice.js` uporabljata `auto/voice.js` (zrak) IN `pre-generate-clips.mjs` (masovna predgeneracija), `server/voiceStatus.js` pa poroča prav skozi isti resolver (»readiness = sinteza, dobesedno ista koda«). Verifikacija iz PRIMARNEGA vira (v1.8.0 `src/piper/__main__.py` + `download_voices.py`) in ŽIVO v čistem kontejnerju: CLI flagi so **identični staremu piperu** (`-m/-f/--input-file/--speaker`), zato stara `.onnx`-pot konfiguracija deluje nespremenjena; `-m` sprejme tudi **glas-ključ** (npr. `sl_SI-artur-medium`), ki ga piper išče kot `<ključ>.onnx` v `--data-dir` (piperjev privzeti = cwd, mi vedno podamo svoj: `<dataDir>/piper/`, nastavljivo `voice.piperDataDir`); **avtomatskega prenosa NI** — manjkajoč ključ javi »Unable to find voice«, zato prenos (`.onnx` + `.onnx.json` s HF `rhasspy/piper-voices`, za slovenščino 63 MB) opravi `ensurePiperVoice()` ENKRAT prek `python3 -m piper.download_voices <ključ> --data-dir <mapa>` (izklop: `voice.piperAutoDownload: false`, napaka pove točen ročni ukaz). Slovenski glas preverjen z HEAD zahtevo: **`sl_SI-artur-medium`** obstaja (200 za `.onnx` in `.onnx.json`), `arturov` ne. ŽIVI preskus: namestitev `pip install piper-tts` (odvisnosti SAMO `onnxruntime`+`pathvalidate` — fonemizacija je v wheelu, **sistemski espeak-ng ni potreben**), prenos glasa 7,6 s, sinteza 3,4 s slovenščine v **2,0 s CPU** (Chatterbox: minute na vrstico), izhod pcm_s16le/22 050 Hz/mono → obstoječa ffmpeg normalizacija na 24 kHz kodeksni dogovor nespremenjena. Zgradba: glas-ključ ALI `.onnx` pot po osebi (`personas.<ime>.piperVoice` + `piperSpeaker`), timeouta `piperTimeoutMs`/`piperDownloadTimeoutMs` (120 s / 10 min), »honest« napake z ukazom za popravilo, temp-datoteke se čistijo tudi ob napaki (regresija audita 2026-10-24 pokrita s testi). Testi: `test/piperVoice.test.mjs` (22: resolucija ključ/pot, točen argv, dogovor prenosa, e2e z lut-pythonom + REAL ffmpeg, studio status; LIVE sinteza za `PIPER_LIVE=1` — izpuščena pošteno brez zastavice). npm test: **238/238** (68 suits; prej 216/61). Reverzibilno: stara pot-konfiguracija deluje naprej; `mode` ostane tak, kot je bil.

## 5. NOVO: matrika primerjave (kandidat × merila)

Oznake: ● polno prileganje, ○ delno, — ne. »LS 2.2.4« = deluje na naši trenutni različici brez nadgradnje.

| Kandidat | Produkc. dokaz | Determinizem | Prileganje Node→m3u→LS | Licenca | LS 2.2.4 | Sodba |
|---|---|---|---|---|---|---|
| autocue (Moonbase59) | ● (AzuraCast) | ● (offline analiza) | ● (annotate polja = naša pogodba) | MIT | ○ (2.2.5; ena minor stran) | **izposoja #1** |
| AzuraCast nit #6252 (standard v številkah) | ● | ● | ● | — (znanje) | ● | **parametri izposoje** |
| uradni cookbook vzorci (§3) | ● (Radio France 77 postaj) | ● | ● (čista .liq) | — (dok) | ● (verificirano 2.2.5 API) | **izposoja #2** |
| SUB/WAVE radio.liq | ● | ● | ○ (request.queue ja; efekti ne) | MIT | — (zahteva 2.4.6+) | P3 po nadgradnji |
| defenestratexp radio | ○ (sveže, 0★) | ● (pravila, predloge) | ● (isti filozofiji) | MIT | ● | **izposoja #3** (pravila rotacije) |
| AzuraCast Clockwheel/Playlist Groups | ● (v glavnem repozitoriju) | ● (koraki po vrsti) | ○ (koncept; implementiramo v Node) | AGPL (koncept) | n/a (Node stran) | **načrt za format uro** |
| WRIT-FM | ○ | ○ (struktura da, vsebina LLM) | ○ (taksonomija tipov) | MIT | n/a | drobci (tipi, min-zaloga) |
| radio-dj | ○ | — (LLM jedro) | ○ (skills, install, sidechain) | MIT | ● | drobci |
| LibreTime Smart Blocks | ● | ● | ○ (kriteriji → rules.js) | AGPL | n/a | koncept |
| `smooth_add` (gist) | ● (uradni operator) | ● | ○ (zahteva ločena vira) | — (dok) | ● | **izposojeno** (P3 #12 ✓) |
| Rivendell / OpenBroadcaster / EBU ostalo | ● | ● | — (težke platforme) | razne | n/a | ne uvajamo |
| WRIT-FM / radio-dj LLM jedra | ● | — (stohastično) | — (proti brez-AI arhitekturi) | MIT | n/a | zavrženo |
| Piper (rhasspy) → piper1-gpl | ● (Home Assistant privzeto) | ● (determinističen TTS) | ● (CLI iz Node) | MIT → GPL-3.0 | ● (CLI neodvisen) | **izposojeno** (P3 #15 ✓) |

## 6. Končna razvrstitev in predlog integracije

| # | Izposoja | Vir | Cena | Učinek | Priložnost |
|---|---|---|---|---|---|
| 1 | ID ob polni uri — overlay `add([radio, switch([({0m0s}, id)])])` **ali** `predicate.activates({0m-5m})` (natančno ena!) | cookbook §3 (2)/(3) | ~1 h + enkratna proizvodnja ID-jev | postaja »diha« kot radio | P1 |
| 2 | autocue analiza → annotate (`liq_cue_in/out`, `liq_fade_out`, `liq_amplify`) | Moonbase59/autocue (MIT) | 1–2 dni (Node offline analizator + m3u writer + test) | tihi začetki, pravi fade-outi, poravnana glasnost | P1 |
| 3 | Periodni imaging: `delay(1800., stingers)` + fallback | cookbook §3 (4) | ~1 h + stingeri | stinger/ID vs. 20–30 min = P1 #3 imaging sloj | P1 |
| 4 | PWA datoteke (manifest + SW) + MediaSession | defenestratexp vzorec | — (že opravljeno v a1c1fee) | namestljivost, zaklenjeni zaslon | P1 ✓ |
| 5 | `source_tag` dispatch prehodov (glasba↔govor v enem mestu) | cookbook §2.5 | pol dneva | posploši naš annotate »0« model, brez crossfade tveganja | P2 |
| 6 | Pametna pravila zaloge (30/izvajalec, 5/(izvajalec,album), 12 h izključitev, uteži vrtenc, boost novosti) | defenestratexp | 1 dan | boljša rotacija od naključja | P2 |
| 7 | Taksonomija segmentov + min-zaloga merilo | WRIT-FM | 2–3 dni | show_intro/outro, mailbag, zdravstveno merilo zaloge | P2 ✓ |
| 8 | `request.queue` vstavljanje namesto reload | SUB/WAVE + defenestratexp | 1 dan | takojšnji ID/zahtevki brez tekmovalnosti z reload | P2 ✓ |
| 9 | dead-air stražar: `blank.strip()` + nujni vir | cookbook §3 (5) + SUB/WAVE | ~2 h | jamski sloj pod mksafe | P2 ✓ |
| 10 | Format ura (clockwheel): koraki → plejlisti, N skladb/korak, dayparts, zahtevkini sloti | AzuraCast PR #8433 dizajn | 2–4 dni (Node) | profesionalen spored, ki ga razume operator | P2 ✓ |
| 11 | nadgradnja LS → 2.4.6 + dj_transition efekti | SUB/WAVE | velik projekt | sweep/washout/dissolve prehodi | P3 |
| 12 | `smooth_add` »postelje« (napoved čez glasbo) | gist §2.6 | srednja, zahteva request.queue | glasba pod govorom brez sidechain procesa | P3 ✓ |
| 13 | sidechaincompress »postelje« (natančnejše od 12) | radio-dj | srednja | glasba pod govorom | P3 |
| 14 | deterministični Smart Blocki (kriteriji → rules.js) | LibreTime | srednja | kriterijski bloki | P3 ✓ |
| 15 | prehod TTS na piper1-gpl (v1.8.0, aktivno) | §4.7 | pol dneva | vzdrževan runtime, nove glasove | P3 ✓ |

**Status P2 #8 (2026-10-24): `request.queue` vstavljanje IMPLEMENTIRANO — odobren zahtevek pride do zraka.**
Do zdaj je odobren zahtevek samo sedel v `requests.jsonl` — do zraka je prišel z ročnimi triki. Zapora zanke:

- **LS polovica** (`radio.liq`): `requests_source = request.queue(id="requests")` + `fallback(track_sensitive=true, [requests_source, radio])` nad stinger slojem (zahtevek na isti meji prekaša imaging). Verificirano iz v2.2.4 vira, ne iz dokumentacije: `src/libs/request.liq` — `request.queue(interactive=true)` registrira telnet ukaza `<id>.push <uri>` (odgovor = ŠTEVILSKI request id!) in `<id>.queue`; razpoložljivost je `available={not list.is_empty(queue())}` — točno to išče track_sensitive fallback; `src/core/tools/server.ml exec` — ukaz/argument se razdelita na PRVEM presledku, zato poti s presledki preživijo celote; napake pridejo kot `ERROR: ...`.
- **Node polovica** (`src/liquidsoap/requestQueue.js`): `pickBestMatch` (fold po diakritikah, izvajalec samo če posluševalec zapiše, izenačene zadetke rešuje ratingCount — kot `dedupeByTitle`; NIKOLI približek — tipkarska napaka ne sme predvajati napačne pesmi), `pushRequestTrack` (gola lokalna pot, brez annotate = trd rez kot stingerji; pred pushom vpiše pot→ratingKey v scrobble stranski indeks, sicer zahtevek zaigra, a ne scrobbla), `queueRequest` (celotna akcija gumba: samo odobren zahtevek, vsak izid — v vrsti / ni v knjižnici / LS ni dosegljiv — gre ISKRENO v zapiske, status ostane `approved`).
- **Studio**: `POST /api/requests/:id/queue` + gumb *Queue* pri odobrenih zahtevkih; CLI za verifikacijo na boxu: `node src/liquidsoap/requestQueue.js queue <id> | push <file> | resolve "<izvajalec>" "<naslov>"`.
- **Testi**: `test/requestQueue.test.mjs` (16) — struktura radio.liq, čista matematika zadetkov, lažni telnet strežnik z pravo žično obliko (odgovor+END), celoten tok lastniške akcije z realnimi WAV.

Live verifikacija na boxu (pred zrakom, kot vedno): `liquidsoap --check radio.liq`, potem en pravi push prek CLI in poslušanje meje (zahtevek mora začeti na naslednji meji skladbe, program pa se vrniti po njegovem koncu).

**Eksplicitna ne-priporočila (raziskana in zavržena):** `cross.smart` (odsvetovan tudi od avtorja autocue; 2.2); global `fade.out` na naši 2.2.4 (utrjen bug: utiša celo skladbo — ostaja prepoved do ponovne verifikacije); SUB/WAVE efekti pred nadgradnjo LS (2.4.5 odvrne delne okvirje po crossu); blankskip na TTS posnetkih (odreže konec sporočila); WRIT-FM/radio-dj LLM jedra in eternityready2 AI newscaster (proti arhitekturi brez AI); Rivendell/OpenBroadcaster/težke platforme (spreminjata infrastrukturo, ne dodajata funkcij); goli `switch({0m-5m})` za ID (prikaže lahko več jinglov — vzemimo `predicate.activates`); `medialib` predmeta (zahteva LS 2.5.x — zanimiv kasneje za kriterijske iskalne bloke).

**Naslednji konkreten korak** (če se strinjaš): #1 + #3 + #9 v enem večeru (čisti `radio.liq`, reverzibilno, vsi trije uradni vzorci že verificirani na 2.2.x API), potem #2 kot prva »velika« izboljšava večernega zvoka — offline analizator v Node, ki zapiše ista annotate polja, ki jih že beremo, torej brez spremembe pogodbe z Liquidsoapom.

## 7. Viri

Moonbase59/autocue (README, predstavitev Liquidshop 4, FAQ) · AzuraCast discussion #6252 »Proof of Concept: More professional AzuraCast/Liquidsoap AutoDJ Crossfading« · AzuraCast discussion #8432 »Introducing Clockwheel Playlists« (z odzivi RM-FM #8434 in Vaalyn PR #8433) · savonet/liquidsoap docs (2.2.5 crossfade, 2.2.5 cookbook — dobesedno prebrano, 2.4.5 complete_case, 2.4.5 quick_start, dev composition) · gist 9ebb70312419427cdb42a7170993faa6 (smooth_add) · liquidsoap.info domača stran (Radio France 77, AzuraCast/LibreTime playout) · perminder-klair/subwave `liquidsoap/radio.liq` (raw) · defenestratexp/liquidsoap-icecast-radio (README) · keltokhy/writ-fm (README, arhitektura) · johncrash64/radio-dj (README) · LibreTime docs · ElvishArtisan/rivendell · ebu/awesome-broadcasting (README prek fetch) · rhasspy/piper (status arhiviran) · OHF-Voice/piper1-gpl (README, izdaje) · rhasspy.github.io/piper-samples (Slovenščina) · promptquorum Piper pregled (primerjava rhasspy vs OHF-Voice). Vse povezave preverjene 2026-10-24 (druga iteracija).
