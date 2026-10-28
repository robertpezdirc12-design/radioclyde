# R128 glasnostna poravnava (autocue, omejen na delujoče na 2.2.4)

Profesionalni radijski sloj, ki poravna glasnost vseh glasbenih skladb na en
skupni cilj (EBU R128), tako da med skladbami ni več skokov glasnosti.
Ozko-izbrani del vzorca **autocue** (Moonbase59, MIT; rojstni list
[AzuraCast #6252](https://github.com/AzuraCast/AzuraCast/discussions/6252)),
kjer je dosledno upoštevano, kaj naš build (Liquidsoap 2.2.4-1+dev)
**realno lahko** izvede — in nič več.

## Zakaj samo `liq_amplify` in ne tudi cue/fade polj

Celoten autocue piše per-datotekne cue točke (`liq_cue_in/out`), fade
dolžine in glasnostno korekcijo (`liq_amplify`). Verificirano iz primarnih
virov (tar balo savonet/liquidsoap v2.2.4 in v2.2.5, 1:1 pregled):

| Polje | 2.2.4 (naš build) | 2.2.5+ | Odločitev |
|---|---|---|---|
| `liq_amplify` | `amplify(override="liq_amplify", 1., s)` ga bere — `amplify.ml` je **bajtno identičen** med 2.2.4 in 2.2.5; format `" %f dB"` (in golo število); brez metadata = gain 1.0 (pass-through) | enako | **UPORABLJAMO** |
| `liq_cue_in/out` | **noben operator ga ne bere** — `cue()` operator in `autocue.liq` stdlib obstajata šele od 2.2.5 | metadata resolver + seek | **NE pišemo** (mrtva polja = zavajanje) |
| `liq_fade_in` | že v uporabi od začetka (fade.in) | enako | nespremenjeno |
| `liq_fade_out` | brez operatorja (fade.out je na tem buildu prepovedan — utiša celo skladbo, utrjeno 2026-07-29) | cross/cue | NE pišemo |

Če postaja boleča tišina na začetkih skladb ali prekiniti konci, je prava pot
**nadgradnja na 2.2.5+** in ena vrstica: `enable_autocue_metadata()` (notranja
implementacija, sama analizira ob predvajanju). Ta modul se ne spremeni — je
gain-only in ostane uporaben.

Dobesedni dokaz iz `amplify.ml` (2.2.4 = 2.2.5):

```ocaml
let s = Hashtbl.find m f in
let k = try Scanf.sscanf s " %f dB" Audio.lin_of_dB
        with _ -> float_of_string s in
self#log#info "Overriding amplification: %f." k;
override <- Some k
```

…in reset ob meji skladbe (`if AFrame.is_partial buf && override <> None then
override <- None`), zato **gain nikoli ne uhaja med skladbe**.

Privzeti cilj **−16 LUFS** je enak uradnemu `settings.autocue.internal.lufs_target`
privzetku v LS 2.2.5 `autocue.liq` — nismo si izmislili lastnega standarda.

## Arhitektura (isti Node-piše/Liquidsoap-beri pogodbeni vzorec)

```
scheduler/autocueScan.js (job, vsak config.autocue.checkIntervalMinutes ?? 60)
  └─ fetchAllTracksAny() → lokalne poti skladb (isti trackLocalPath vzorec kot filler)
  └─ lib/autocue.js analyzeMissing(): za nove/spremenjene datoteke po en ffmpeg ebur128 prehod
       ├─ shrani { lufs, peak, mtimeMs, size } v dataDir/autocue_index.json (atomski tmp+rename)
       ├─ TAIL: po uspešni glasnostni analizi še en prehod (-sseof -20, momentna serija)
       │    └─ shrani tail { windMs, fade, lufsDrop }; napaka šteje tailFailed, vnos gre BREZ repa
       └─ budget: maxAnalyzePerRun (privzeto 100) — prvi sweep velike knjižnice se raztegne čez tike
director/playlist.js annotateTrackEntry(): za vsak glasbeni vnos pogleda indeks
  └─ z analizo:  annotate:liq_fade_in="2",liq_amplify="-2.3 dB":<pot>
  └─ + fade-out rep: liq_cross_duration="9.0" (izpelje se ob branju, 8–12 s)
  └─ brez nje:   annotate:liq_fade_in="2":<pot>        (točno kot prej)
liquidsoap/radio.liq: radio = amplify(override="liq_amplify", 1., radio)
  └─ pred emergency fallbackom: le programski skladbi se poravna,
     govor/jingle/imaging (brez polja) ostanejo na producentski glasnosti
liquidsoap/radio.liq: cross_stamps (metadata.map) → liq_cross_start/end_duration → cross(dj_transition)
  └─ žig iz m3u prevede v eksplicitna start/end ključa; nezapisani → dj_transition_buffer (3,5 s)
```

Ključna dizajnerska odločitev: v indeks se shrani **samo izmerjeno** (LUFS,
peak). `amplify` se **izpelje ob branju** iz trenutnega `targetLufs` —
sprememba cilja v configu učinkuje ob naslednjem prepisu plejliste, brez
re-analize.

## Config

```json
"autocue": {
  "targetLufs": -16,        // ciljna integrirana glasnost (LS 2.2.5 privzetek)
  "maxGainDb": 6.0,         // zgornja meja pozitivne korekcije (varnost)
  "checkIntervalMinutes": 60,
  "maxAnalyzePerRun": 100
}
```

- Blok je opcijski: brez njega job teče z enakimi privzetki; obstoječi configi
  se ne pokvarijo (F2 pravilo `?.` + privzetek).
- `maxGainDb` obstaja, ker v verigi **ni limiterja**: ojačati zelo tih master
  nad +6 dB bi pomenilo klipanje skozi MP3 kodirnik. Negativne korekcije se
  nikoli ne omejujejo (utišanje je vedno varno). Števec zaskočenih gre v log
  ("gain-clamped N") — če raste, je cilj preveč agresiven za knjižnico.

## Zaključni prehod (tail pass): fade-out repovi in `liq_cross_duration`

Druga izmera iz istega off-line joba: poleg integrirane glasnosti celotne
skladbe vsaka nova/spremenjena datoteka po uspešni glasnostni analizi dobi
še **prehod po zadnjih 20 s** (`-sseof -20`), ki iz ebur128 **momentne**
serije izračuna `tail: { windMs, fade, lufsDrop }` in ga shrani v isti
indeks. Ob branju se iz repa izpelje žig `liq_cross_duration="8.0".."12.0"`
(samo za izmerjene fade-out konce), ki ga `director/playlist.js` zapiše na
m3u vrstico; radio.liqov `cross_stamps` ga nato prebere (spodaj). Vzorceno
iz SUB/WAVE (worklog 4-a, točka 4, presoja STEALABLE-WITH-FFMPEG-ONLY).

```bash
ffmpeg -hide_banner -nostats -sseof -20 -i <datoteka> \
  -filter_complex 'ebur128=metadata=1:framelog=info' -f null -
```

**Odstopanje od briefa (izmerjeno na tem boxu, ffmpeg 7.1.5):** natančen
filter `ebur128=metadata=1` natisne **NIČ** momentnih vrstic (0 proti 200 z
eksplicitnim `framelog=info`) — ffmpeg >= 6.1 ob vklopljenem `metadata`
izklopi dnevniškenje okvirjev. `framelog=info` je na starejših buildih
privzeta vrednost (no-op), zato dodatek ne škodi nikjer. Oblika vrstice na
7.x je `t: 0.0999773  TARGET:-23 LUFS    M:-120.7 S:-120.7` (brez dvopičja
za številko `t`; brez presledka za `M:`, kadar je vrednost široka — ffmpeg
zapolnjuje do fiksne širine, zato se pojavita obe obliki, `M:-120.7` in
`M: -41.7`); parser sprejema tudi starejšo obliko s dvopičjem
(`t: 0.0999773:`). Digitalna tišina na 7.x tiska M ≈ −159/−163 (nikoli
`-inf`; `-inf` ostaja v parserju za starejše builde); vse pod −60 LUFS se
poreže na pod −60. Na datoteki, krajši od 20 s, `-sseof -20` dekodira celo
datoteko (izmerjeno) — neškodljivo.

### Metrike (`tailMetrics`)

| Metrika | Definicija | Prag | SUB/WAVE izvor |
|---|---|---|---|
| p95 | 95. percentil momentne serije okna (linearna interpolacija) | telesna glasnost | `loud = p95(rms)` |
| konec (`endIdx`) | zadnji indeks strogo nad podom −60 LUFS | — | obrez končne tišine: sled tišine je padding, ne zaključek |
| veter (`windMs`) | `t[endIdx] − t[k]`; k = zadnji indeks ≤ endIdx z M ≥ p95 − 4,44 dB | ≥ 3000 ms | `thr_hi = 0,6·loud` (0,6 amplitude ≈ −4,44 dB); `wind_span ≥ 3 s` |
| rep (`tailMean`) | povprečje zadnjih 1,5 s **obrezanega** konca (samo indeksi ≤ endIdx) | — | `end_level = mean RMS zadnjih 1,5 s`; meja na obrezan konec preprečuje, da bi digitalni padding napihnil `lufsDrop` |
| `fade` | `windMs ≥ 3000` IN `tailMean < p95 − 16,5 dB` | −16,5 dB | `end_level < 0,15·loud` (0,15 amplitude ≈ −16,5 dB) |
| `lufsDrop` | `max(0, p95 − tailMean)`, zaokroženo na 0,1 dB | — | `drop = bodyLufs − tailLufs` |

Vse-tiho okno vrne ničle `{windMs: 0, fade: false, lufsDrop: 0}`; prazna
serija vrže napako, ki jo klicatelj šteje v povzetek `tailFailed`.

### Odločitvena tabela ob branju (`crossSecondsFor`)

| Konec | Žig na m3u | SUB/WAVE vzporednica | Odločitev |
|---|---|---|---|
| izmerjen fade-out | `liq_cross_duration` 8–12 s | `endingCrossSecondsFor`: `secs = windDownSec`, clamp [8,12] | **UPORABLJAMO** |
| oblikovanje po globini padca | `t = clamp01((drop − 3)/(12 − 3))`; `secs = 8 + (windSec − 8)·t` | isto | **UPORABLJAMO** |
| zapeti rep (vocalTail) | — | sek = 8 s ravno («dolg prekriv postavi naslednjo skladbo pod petje») | **PADLO**: NEEDS-AI (Demucs ločitev vokala) |
| mrzel rez (cold) | — | sek = 4 s («čist namerni rez») | **PADLO**: spuščeno, da privzet `dj_transition_buffer` (3,5 s) ostane za vse nezapisane konce |
| snap na takt (bar grid) | — | `bars·240/bpm`, velja 3 ≤ snap ≤ 14 | **PADLO**: NEEDS-PYTHON-DSP (librosa `beat_track` brez ffmpeg ekvivalenta) |

Iskrena opazka o dosegljivosti: ker je `lufsDrop = p95 − tailMean` in
`fade = true` zahteva `tailMean < p95 − 16,5 dB`, ima vsak pošteno izmerjen
rep drop > 16,5 dB — torej je `t` vedno nasičeno na 1 in žig === (v pas
8–12 s obrezan) `windSec`. Interpolacijska veja (drop 3–12 dB) je iz realnih
meritev **nedosegljiva**; držimo jo zaradi vernosti SUB/WAVE tabele in
robustnosti ročno urejenih indeksov (matematiko pokrivajo čisti testi).

### radio.liq: CROSS STAMPS (Liquidsoap polovica)

Žig pomeni «prehod IZ te skladbe traja toliko». `cross()` velikost
odhajajočega repa sicer bere iz `liq_cross_end_duration` in prihajajoče
glave iz `liq_cross_start_duration`, a en sam žig na skladbo ne more držati
obeh v koraku: `cross` znova uporabi override ključe, ki jih najde v SVOJEM
izhodu, prehod pa predvaja metapodatke ODHODNE skladbe — vsak rep bi bil
sicer velik po žigu skladbe PRED njo (SUB/WAVE je izmeril 3931 od 3997
zabeleženih prehodov napačno velikih pred tem popravkom). Zato `radio.liq`ov
`cross_stamps` (`metadata.map` med `source.dynamic` in `cross`) žig prevede
v eksplicitni `liq_cross_start_duration` (= prejšnji konec) +
`liq_cross_end_duration` na vsako skladbo in surov ključ počisti
(`liq_cross_duration=""`); `strip_cross_stamps` v `dj_transitions.liq` drži
ključe stran od izhodnih okvirjev prehoda. `sequence()` rezi (govor/jingle →
glasba) so trdi rezi: tam se rep predvaja v celoti, ne glede na velikost
žiga. Žig je v radio.liqu omejen na 30 s (koruptiran/ročno urejen indeks),
Node piše samo 8–12 s.

### Ponovno žigosanje

Žig se izpelje ob branju iz `tail` v indeksu, zato vnosi, pisani pred tem
prehodom, ostanejo brez žiga, dokler se ne re-analizirajo — preskok
`mtimeMs+size` namreč pomeni, da stari vnos nikoli ne pridobi repa brez
re-analize. Kdor hoče obstoječo knjižnico pre-žigosati, izbriše
`dataDir/autocue_index.json` in pusti jobu, da ga zgradi znova.

## Uvodni prehod (vocal pass): rampa, »hit-the-post« in `liq_ramp` (Val 32)

Tretja izmera istega off-line joba (za glasnostjo, glavnim fade-in prehodom
Val 28 B1 in repnim prehodom): po uspešni analizi vsaka nova/spremenjena
datoteka dobi še **prehod po prvih 32 s**, pasovno omejen na 250–3200 Hz
(območje formantov, kjer živi glas; bas kitara in boben sedijo pod njim,
cimbalski um nad njim), spet ebur128 momentna serija. Prva TOČKA, kjer pas
drži ≥ +4,5 dB nad lastno izhodiščno linijo obrezanega začetka ≥ 1,2 s, je
zapolnitev introja — shranjena kot `vocal: { onsetMs }` (null, kadar se
intro v 32 s nikoli ne zapolni). Trajanje drže je namerno: bobenski vložek
ali ena sama nabrana nota ne držita 1,2 s, kitarski tematski vstop pa drži —
za rampo je tudi to pravi »post«, ne samo vokal.

```bash
ffmpeg -hide_banner -nostats -t 32 -i <datoteka> \
  -filter_complex 'highpass=f=250,lowpass=f=3200,ebur128=metadata=1:framelog=info' -f null -
```

(Konstante v `src/lib/autocue.js`: `VOCAL_WINDOW_SECONDS=32`,
`VOCAL_BAND_HIGHPASS_HZ=250`, `VOCAL_BAND_LOWPASS_HZ=3200`,
`VOCAL_RISE_DB=4.5`, `VOCAL_SUSTAIN_SECONDS=1.2`.)

Ob branju `rampStampFor` (director/playlist.js `resolveRampSeams`) odloči,
ali GOVORNI šiv postane rampa: žig `liq_ramp="1"` na OBEH straneh šiva, en
sam intro klip (spliciran open+intro nikoli — rampa predstavi ENO
skladbo), govor ≤ okno ≤ zapolnitev − 1,5 s robu (`RAMP_MARGIN_SECONDS`:
spust 0,6 s + zamik detektorja + dih), okno ≥ 5 s (tesneje od tega
tveganje pretehta potezo) in govor ≤ 20 s (DJ-jev rampni budget, pod
cross_stamps capom 30 s). `dj_transitions.liq`ova RAMPA veja (za
`%ifversion >= 2.4.6`, kot vsi prehodi — na 2.2.4 so žigi nedejavni in
šiv ostane trd rez) zaigra govor NAD duckano pesmijo (0.2, isti programski
floor kot postelje) in jo čez zadnji del govora dvigne nazaj na 1.0
(smoothstep, spust 0,6 s). Živo izmerjeno na uradni 2.4.6 (2026-10-28,
Goertzel sonda: govor 412,8 polno, pesem 82,5 = točno 0,2, dvig
~0,3–0,5 s na šivu, pesem naprej nedotaknjena).

Iskrene meje: (1) prekrivanje je dolgo kot crossovo okno sprožitve
prehoda (~4,6 s izmerjeno na 8-s govoru) — rampa pokrije ZADNJI del
govora, ne vsega; (2) detekcija meri zapolnitev, ne vokala; (3) pesmi,
ki so glasne od prve sekunde, ne nosijo okna (onset null → brez rampe,
današnji trd rez); (4) neizmerjena knjižnica je bajtno-identična — vnos
brez `vocal` nikoli ne rampa (preskok mtimeMs+size: pre-žigosanje =
izbris indeksa, enako kot pri repu). Napaka prehoda se šteje v
`vocalFailed`, vnos se shrani brez `vocal`, `liq_amplify`/`tail` pa
ostaneta nespremenjena. Vrata: `config.autocue.rampTalk.enabled`
(privzeto vklopljeno; sloj je dvojno zaprt — različica prek %ifversion ≥
2.4.6 IN podatkovno: brez izmere ni rampe — izrecna izklopitev je za
postaje, ki hočejo staro vedenje tudi po nadgradnji).

## Iskrena degradacija

| Stanje | Vedenje |
|---|---|
| Scan še ni tekel / indeks prazen | noben vnos nosi `liq_amplify` → postaja se točno kot prej |
| Datoteka ni bila analizirana (budget) | predvaja se neporavnana, dokler je ne prime naslednji tik |
| Indeks pokvarjen | degradira na prazen (pass-through), naslednja uspešna analiza ga prepriše |
| ffmpeg manjka | analize failajo in se štejejo; postaja brez spremembe |
| govor / jingle / ID / stinger / emergency | nikoli ne nosijo polja — fiksna producentska glasnost |
| Repni prehod pade (ffmpeg) | vnos se shrani BREZ repa + števec `tailFailed`; `liq_amplify` nespremenjen; konec dobi privzeti 3,5 s prehod |
| Vokalni prehod pade (ffmpeg) | vnos se shrani BREZ `vocal` + števec `vocalFailed`; rampa nikoli ne zaigra, `liq_amplify`/`tail` nespremenjena |
| Star indeksni vnos (pred repnim prehodom) | nikoli ne dobi žiga (preskok mtimeMs+size); pre-žigosanje = izbris indeksa |

## Reverzibilnost

1. Odstrani vrstico `radio = amplify(override="liq_amplify", 1., radio)` iz
   `liquidsoap/radio.liq` — postaja je takoj nazaj na prejšnje vedenje (polja
   v m3u ostanejo neškodljiva, ker jih ni več kdo bere).
2. Izbriši job vrstico v `scheduler/scheduler.js` in `autocue` blok iz configa.
3. `dataDir/autocue_index.json` je čisti side index — brisanje ni škodljivo.
4. Za žig konca (brez dotikanja glasnosti): odstrani potisk
   `liq_cross_duration` v `annotateTrackEntry` (director/playlist.js) — m3u
   takoj izgubi žige, nezapisani kosi pa igrajo s privzetim
   `dj_transition_buffer` (3,5 s), točno kot pred tem.

## Verifikacija na boxu

```bash
# 1) Ročna analiza posamezne datoteke (JSON na stdout; rep je opcijsko polje
#    — tailError pomeni, da je repni prehod padel, glasnostna izmera pa
#    kljub temu velja):
node src/lib/autocue.js /pot/do/skladbe.mp3
# -> {"file":"...","lufs":-21.1,"peak":-21.1,"amplify":5.1,"clamped":false,...,
#     "tail":{"windMs":7100,"fade":true,"lufsDrop":32.6}}

# 2) Enkratni scan brez schedulerja:
node src/scheduler/autocueScan.js

# 3) Liquidsoap check (če je na boxu):
liquidsoap --check /home/ai/radioclyde/liquidsoap/radio.liq

# 4) Na zraku: ko pride skladba z liq_amplify na vrsto, mora v LS logu biti
#    "Overriding amplification: <faktor>" (amplify.ml log vrstica), in
#    vrednosti med skladbami morajo zveneti poravnano.

# 5) Žigi konca na m3u: fade-out kosi morajo nositi liq_cross_duration,
#    hladni kosi / govor / jingle / stari vnosi pa ne:
rg 'liq_cross_duration' data/now_playing.m3u data/filler.m3u
```

## Omejitve (pošteno zapisano)

- Analiza je **offline** (job interval); zelo sveže dodana skladba igra en tik
  neporavnana. Radijsko to ni problem (katalog se spreminja počasi).
- `ebur128` meri **integrirano** glasnost — ne ločuje "tihega introa" od
  celote; to je standard radijske normalizacije, ne napaka.
- True peak po pozitivni korekciji se **ne limira** — zato `maxGainDb` in
  zato clamp obstaja. Če bo knjižnica zelo tiha, razmisli o višjem cilju
  (npr. −18 LUFS) namesto dvigovanja `maxGainDb`.
- Cue točke/fadei (profesionalna nadgradnja): šele po premiku na LS 2.2.5+,
  kjer `enable_autocue_metadata()` pokrije vse v eni vrstici.
- Repni prehod je prav tako **off-line**: sveže dodana skladba en tik igra
  z nezaznanim koncem (privzeti 3,5 s prehod), tako kot z neizmerjeno
  glasnostjo.
- Momentna okna ebur128 so 400 ms s 100 ms kadenco: resolucija vetra je
  ~0,1 s. Momentna vrednost je prehodna (gated) glasnost, ne RMS — pragovi
  so dB-ekvivalenti SUB/WAVE-ovih amplitudnih vrat (0,6 ≈ −4,44 dB,
  0,15 ≈ −16,5 dB), ne njihove mere.
- Interpolacijska veja (drop 3–12 dB) je iz realnih meritev nedosegljiva
  (glej opazko o dosegljivosti) — žig === obrezan `windSec` za vsak
  pošteno izmerjen rep.
- Vetrovi, daljši od 12 s, se obrežejo na 12 (pas mešanja); SUB/WAVE bi
  dovolila do 14 s s snapom na takt, ki ga namerno nimamo.
