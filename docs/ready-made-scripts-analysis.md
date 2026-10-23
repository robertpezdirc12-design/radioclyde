# Najboljše pripravljene skripte na GitHubu: samodejne oddaje, prehodi govor↔glasba, napovedovanje

*Datum: 2026-10-24 · raziskava nad živimi viri (raw GitHub, dokumentacija, AzuraCast razprave) · Radio Clyde main `96afcfe`, Liquidsoap 2.2.4-1+dev*

Naloga: najti **že pripravljene** skripte z največ funkcijami za (1) samodejno generiranje oddaj, (2) prehode med govorom in glasbo, (3) napovedovanje (ID-ji, časniki, vreme/novice). Vsak nosilec je ocenjen po: dokaz v produkciji, determinističnost, prileganje naši arhitekturi (Node piše m3u + annotate → Liquidsoap mixa), licenca, cena integracije. Na koncu je urejen predlog integracije.

---

## 1. Naša izhodiščna točka (iskrena samopodoba)

`liquidsoap/radio.liq` (132 vrstic) je danes minimalen: `playlist(now_playing.m3u, watch)` → `fade.in` z annotate `liq_fade_in` (skladbe se zavejo, govor dobi »0« = trz» rez) → `fallback(track_sensitive=false, [show_source, filler_source])` + `mksafe` → en MP3 Icecast mount. Ključna zgodovina: `crossfade()` je že **dvakrat spodletel** (obrezal je živ govor DJ-ja; global `fade.out` v tej verziji utiša celo skladbo), zato so prehodi rešeni z vnaprej renderiranim fade-out (samo jingle) in hard cut povsod drugje. To je varno, a zveni »digitalno«. Prav ta bolečina je v svetu Liquidsoapa že dvakrat rešena — spodaj.

## 2. Prehodi govor↔glasba — uvrstitev

### 2.1 Zmagovalec: autocue (Moonbase59, MIT) — in je že VGRADJEN v Liquidsoap

Repo: `https://github.com/Moonbase59/autocue` (51★, MIT, 225 commitov, zadnja aktivnost 2024-10). Dela: `cue_file` (Python3 + ffmpeg ebur128 + Mutagen) analizira vsako datoteko in vrne JSON: `liq_cue_in`, `liq_cue_out`, `liq_cross_start_next`, `liq_fade_in/out`, **`liq_amplify` (R128 glasnost → dB korekcija)**, `liq_longtail`, `liq_sustained_ending`, true peak, blankskip. Integracija: protokol `autocue:` (`%include autocue.cue_file.liq`) ali **od 2.2.5 vgrajeno**: `enable_autocue_metadata()` — ena vrstica (notranja implementacija, samo ffmpeg povezave).

Zakaj je to točno naš primer: (a) narejen za LS **2.2.5** (mi: 2.2.4 — ena minor verzija; pri 2.3.x imajo težave, ne obratno); (b) vgrajen v AzuraCast od 2024-05; (c) **ne prekriva virov** — oblikuje ovojnico posamezne datoteke (cue/fade/loudness), torej ne trpi problema, ki je ubil naš `crossfade()`; (d) R128 normalizacija je pravi mehanizem za »nivojsko poravnane« meje govor↔glasba, ki jih trenutno dosegamo le sStaticnimi ugibi; (e) podpira predobdelavo z oznakami (»za dramatično hitrost«) — naš Node scheduler lahko analizira enkrat, offline.

Opozorila, dobesedno iz README: »Ne uporabljajte blankskip s govorjenim ali TTS-generiranim besedilom — pogosto odreže sporočilo« (naš govor ima lastno pot z annotate »0«, tako da varno); »Pred spreminjanjem nastavitev točno vedite, kaj počnete«. Privzete nastavitve (za našo dokumentacijo): fade_in 0,1 s, fade_out 2,5 s, cilj −18 LUFS, tišina −42 LU, overlay −8 LU, longtail 15 s.

### 2.2 AzuraCast »Profesionalni Crossfade« (nit #6252, Moonbase59) — radijski standard v številkah

Vir: `github.com/AzuraCast/AzuraCast/discussions/6252` (127 komentarjev; rojstni list autocue). Kostni izvleček, ki vreden zapisa v našo dokumentacijo: »V radiu navadno NE uporabljamo fade-inov«; radijski standard: **fade_in = 0 s, fade_out = 3,5 s, začetek fade-out pri −15 dB (EBU R128), največji preklop 4,0 s, okno računanja moči 2,0 s**; priporočljiva kombinacija: `amplify(1., override="replaygain_track_gain", radio)` pred `cross()` in `cross.simple(old, new, fade_in=0.00, fade_out=3.50)` znotraj `cross(minimum=0.00, duration=4.00, width=2.00, …)`; izrek avtorja: **»Ne uporabljajte cross.smart, ker ni tako pameten«** (pravila po dB povprečjih so pregroba). Podatkovna pot: AzuraCast od LS 2.2.x pošilja **annotate na vsako skladbo** (`liq_fade_in`, `liq_fade_out`, `liq_cue_in/out`, `liq_amplify`) in se zanaša na samodejno ponastavljanje oznak — točno isti model, ki ga že uporablja naš director (`annotate:liq_fade_in=…` v m3u). To pomeni: naša arhitektura je že na pravi poti, manjka le **realna analiza** za vrednosti namesto ugibov.

### 2.3 SUB/WAVE `radio.liq` (MIT, 2.324 vrstic) — najbogatejši enoten primer, a zahteva nov Liquidsoap

Vir: `raw.githubusercontent.com/perminder-klair/subwave/main/liquidsoap/radio.liq`. Izvlečki, ki so vredni učenja ne glede na različico: (a) **±6 dB invarianta preklopa** — »fade.out/fade.in morata segati čez CEL cross buffer, sicer izhodna ostane na polni glasnosti ob prilivanju prihajajoče: +6 dB, čuten podvajanj«; (b) **cross žigi** — en liq_cross_duration na skladbo se prepiše v ločena start/end žiga, ker `cross` sicer velikost izhodnega repa velikosti po oznaki PREJŠNJE skladbe (izmerjeno: 3.931/3.997 prehodov); (c) `cue_cut` za trdne omejitve dolžine; (d) **dead-air stražar**: `fallback([music, emergency])` s 30 s rožnatim šumom + `music-starved.json` srčni utrip; (e) `request.queue` polnjen iz `next.txt` (poll 1 s) — mehanizem vstavljanja brez reload; (f) `subhttp` protokol, ki **zavrača JSON/XML body kot »ne-zvok«** (Navidrome vrne 200 z napako!) in <4 KiB datoteke; (g) runtime nastavitve prek besedilnih datotek. **Ključna ovira, dobesedno iz datoteke:** »v2.4.6 je NAJMANJŠI runtime; 2.4.4 O(n) clock scan zasede jedro, 2.4.5 odvrne delni okvir po vsakem cross« — torej SUB/WAVE-jevi efekti (chop/washout/dissolve) so za nas šele po nadgradnji na 2.4.6+. To je projekt P3, ne današnja izposoja.

### 2.4 uradni `cross.smart` (dok. Liquidsoap 2.2.5) — vzemite kot učbenik, ne kot rešitev

Vir: `liquidsoap.info/doc-2.2.5/crossfade`. Javna koda (dB-pravila: medium −32, high −15, margin 4 dB → izbere full-cross/fade-out/fade-in/no-fade/default). Uporabna kot referenčna taksonomija prehodov; v praksi odsvetovana (2.2). Ničesar ne uvajamo.

## 3. Napovedovanje — uradni vzorci (canonical answer)

Vir: `liquidsoap.info/doc-2.4.5/complete_case` + cookbook. To so zapisane rešitve za našo vrzel »ni ID ob polni uri«:

```liquidsoap
# ID postaje na polni uri, zmešan NAD programom:
radio = add([radio, switch([({0m0s}, clock_jingle)])])
# Jingle vsakih ~5 skladb:
radio = random(weights=[1, 5], [jingles, radio])
# Dan/noč sporedi:
radio = fallback([request.queue(id="request"),
                  switch([({6h-22h}, day), ({22h-6h}, night)]), default])
```

Naš primer: obstoječi pre-renderirani jingle + novi ID-ji (Piper, enkratna proizvodnja) v `switch([{0m0s}, …])` — nič novega v Node, čista `radio.liq` sprememba, enostavno reverzibilna. To je najcenejša izboljšava »zveni kot radio« na celotnem seznamu.

## 4. Samodejna generacija oddaj — uvrstitev

### 4.1 defenestratexp/liquidsoap-icecast-radio (MIT) — glasanje: arhitekturno nas dvojček

Repo: `github.com/defenestratexp/liquidsoap-icecast-radio` (0★, sveže 2026-09, Ansible, MIT). Pomembnost ni v zvezdicah, temveč v tem, da je **edini najdeni projekt z identično filozofijo**: fiksni predlogni tekstri + Piper TTS + žanrski sporedi + play log, brez LLM. Njegov DJ tok: Liquidsoap vsakih 5 skladb zapiše oznake zadnjih treh skladb v datoteko → `dj-announce.sh` napolni fiksne predloge (»From the album X by Y, that was Z … Next up …«) → Piper → ffmpeg 44,1 kHz/128k MP3 → **`request.queue`** predvaja med skladbami. Izposojljivo konkretno: (a) pravila pametnega plejlista — deduplikacija po (izvajalec, naslov), **omejitve 30 skladb/izvajalec in 5/(izvajalec, album)** (kompilacije se ne izstradajo), izključitev vseh predvajanih v zadnjih 12 h, **utež po 7-dnevnem števcu vrtenc** (manj predvajane pridejo prej), boost novosti (7 dni); (b) `audit-show-playlists.sh` — poročilo skladb z napačnim žanrom v sporedu (določena vsebina za naš Diagnostics); (c) `radio-manifest.json.j2` + `radio-sw.js.j2` — PWA datoteke, neposredno prenosljive za naš P1 (MediaSession+PWA); (d) naslednja skladba prek telnet `music.next` + ffprobe za »Next up« besedilo — deterministična nadgradnja našega liveLines predlog.

### 4.2 WRIT-FM (382★, MIT) — struktura je deterministična, vsebina AI (preverjeno)

Repo: `github.com/keltokhy/writ-fm`. Vsebinski generator je LLM (Claude/Kodex) + Kokoro/Chatterbox/Voxtral; **struktura pa je vredna kopiranja tudi nam**: taksonomija segmentov (deep_dive, news_analysis iz RSS, interview, panel, story, **listener_mailbag**, music_essay + kratke: **station_id, show_intro, show_outro** kot prvovrstni vsebinski tipi), tedenski premik (nedeljski »Listener Hours«), **min-zalogovanje** (≥3 govorni prekini/slot, ≥20 skladb/oddaja — javno zdravstveno merilo), station-local topic bank + append-only **uredniški vodnik** (kontinuiteta med oddajami), več-stancijska izolacija (WRIT/KLOD/CDEX iz enega runtime). Za nas: tipi segmentov se 1:1 prevedejo v naše template vrste (liveLines + prewarmed slots), min-zaloga pa v Diagnostics »vsebina pripravljena za naslednji slot«.

### 4.3 radio-dj (60★, MIT, Go 8,7 MB) — drobci

Veščine kot **urejanje besedilnih datotek** (`~/.radio-dj/skills/`, brez prevajanja), `radio-dj install` (ustvari systemd/launchd/OpenRC enoto), ffmpeg **sidechaincompress** ducking (DJ govor čez glasbo — pri nas trenutno nič, ker naš govor nikoli ne teče čez glasbo; zanimivo za prihodnje »postelje«), PWA UI z DJ dnevnikom. Jedro je LLM direktor — ostalo je mehanika.

### 4.4 LibreTime Smart Blocks + Rivendell — modeli pravil

LibreTime (AGPL): kriterijski bloki (»12 ambient skladb < 6 min«) — polje/kriteriji/operaterji so prenesljivi v naš rules.js kot »deterministični Smart Block«. Rivendell: RDCatch planirani snemalnik (vzorec za samodejne vremenske/novičarske prevzeme v fiksne ure) — koncept, ne koda.

## 5. Končna razvrstitev in predlog integracije

| # | Izposoja | Vir | Cena | Učinek | Priložnost |
|---|---|---|---|---|---|
| 1 | ID ob polni uri + rotacija jinglov (`switch`/`random(weights)`) | uradni cookbook | ~1 h + enkratna proizvodnja ID-jev | postaja »dihá« kot radio | P1 |
| 2 | autocue analiza → annotate (`liq_cue_in/out`, `liq_fade_out`, `liq_amplify`) | Moonbase59/autocue (MIT) | 1–2 dni (Node offline analizator + m3u writer + test) | tihi začetki, pravi fade-outi, poravnana glasnost — zven »profesionalnega AutoDJ« | P1 |
| 3 | PWA datoteke (manifest + SW) + MediaSession | defenestratexp vzorec | 1 dan | namestljivost, zaklenjeni zaslon | P1 (že planirano) |
| 4 | Pametna pravila zaloge (omejitve/izvajalec, uteži vrtenc, boost novosti) | defenestratexp | 1 dan | boljša rotacija od naključja | P2 |
| 5 | Taksonomija segmentov + min-zaloga merilo | WRIT-FM | 2–3 dni | show_intro/outro, mailbag, zdravstveno merilo zaloge | P2 |
| 6 | `request.queue` vstavljanje namesto reload | SUB/WAVE + defenestratexp | 1 dan | takojšnji ID/zahtevki brez tekmovalnosti z reload | P2 |
| 7 | dead-air stražar z nujnim virom | SUB/WAVE | ~2 h | jamski sloj pod mksafe | P2 |
| 8 | nadgradnja LS → 2.4.6 + dj_transition efekti | SUB/WAVE | velik projekt | sweep/washout/dissolve prehodi | P3 |
| 9 | sidechaincompress »postelje« | radio-dj | srednji | glasba pod govorom | P3 |
| 10 | deterministični Smart Blocki | LibreTime | srednji | kriterijski bloki v rules.js | P3 |

**Eksplicitna ne-priporočila (raziskana in zavržena):** `cross.smart` (odsvetovan tudi od avtorja autocue; 2.2); global `fade.out` na naši 2.2.4 (utrjen bug: utiša celo skladbo — ostaja prepoved do ponovne verifikacije); SUB/WAVE efekti pred nadgradnjo LS (2.4.5 odvrne delne okvirje po crossu); blankskip na TTS posnetkih (odreže konec sporočila); WRIT-FM/radio-dj LLM jedra (proti arhitekturi brez AI).

**Naslednji konkreten korak** (če se strinjaš): #1 + #7 v enem večeru (čisti `radio.liq`, reverzibilno), potem #2 kot prva »velika« izboljšava zvečnega zvoka — offline analizator v Node, ki zapiše ista annotate polja, ki jih že beremo, torej brez spremembe pogodbe z Liquidsoapom.

## 6. Viri

Moonbase59/autocue (README, predstavitev Liquidshop 4, FAQ) · AzuraCast discussion #6252 »Proof of Concept: More professional AzuraCast/Liquidsoap AutoDJ Crossfading« · savonet/liquidsoap docs (2.2.5 crossfade, 2.4.5 complete_case, cookbook, migrating) · perminder-klair/subwave `liquidsoap/radio.liq` (raw) · defenestratexp/liquidsoap-icecast-radio (README) · keltokhy/writ-fm (README, arhitektura) · johncrash64/radio-dj (README) · LibreTime docs · ElvishArtisan/rivendell. Vse povezave preverjene 2026-10-24.
