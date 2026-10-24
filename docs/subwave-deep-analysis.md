# SUB/WAVE — temeljita analiza referenčnega projekta in primerjava z Radio Clyde

*Datum: 2026-10-24 · analiza opravljena nad stanjem SUB/WAVE v1.27.0 (2026-10-22) in Radio Clyde main `3b04491`*

Issue #2 je bil naveden kot »SUB/WAVE-inspired listener and owner interface«. To poročilo je poglobljena analiza te reference: kaj SUB/WAVE dejansko je, kako je zgrajen, kaj njegov ekosistem počne, kje je **boljši od Radio Clyde**, kje je Radio Clyde boljši, in katere ideje si lahko vzamemo **brez kršenja arhitekture brez AI**. Za širšo pokrajino (AzuraCast, LibreTime, WRIT-FM, Talk-Wave …) glej prilogo — tam je še več izposojljivih idej, ki jih SUB/WAVE sam nima.

---

## 1. Povzetek (TL;DR)

SUB/WAVE je **komercialno zasnovan ekosistem** okoli odprtokodne jedre: osebna internetna postaja z agentic AI DJ-jem (en deljen Icecast tok, LLM izbere pesmi in govori med njimi). Repozitorij `perminder-klair/subwave` ima ~1.445 zvezdic, MIT licenco in neverjetno hitrost razvoja (111 izdaj in ~2.000 issue-jev/PR-jev v 5,5 mesecih). Okoli jedre živijo štiri krovne plasti: živa postaja getsubwave.com, forkabilen referenčni spletni predvajalnik, nativni namizni predvajalnik (Zig, brez brskalnika) ter iOS/Android aplikacije v trgovinah.

**Ključna spoznanja:** (1) SUB/WAVE-jeve najmočnejše prednosti so **deterministični mehanizmi** — datotečni pogodbeni IPC z Liquidsoapom, prehodi med pesmimi, ki se prilagajajo koncu skladbe, večformatni tokovi, iskrena analitika — te Radio Clyde lahko prevzame **brez kakršne koli AI**. (2) Njegova prava šibkost je LLM plast: nepredvidljivost je dokumentirana v lastnih issue-jih, stroški so večni, vsebina je samoangleška. (3) Radio Clyde že ima dve stvari, ki jih SUB/WAVE prodaja: nativni Android TV in Android mobilni odjemalec sta del našega repozitorija od začetnega commita. (4) Največje vrzeli Radio Clyde na strani poslušalca so PWA/MediaSession, `.pls`/`.m3u` končne točke, vršni števec poslušalcev in priporočilni čipsi pri zahtevkih — vse cenenjše, kot se zdi na prvi pogled.

---

## 2. Kaj SUB/WAVE dejansko je

Referenca iz issue #2 je `https://github.com/perminder-klair/subwave` — »Personal internet radio: Agentic AI DJ«. Besedna zveza, s katero se projekt trži, je tudi njegova productska izjava: »To je radio, ne plejlista. Brez preskakovanja, brez naključnega predvajanja, brez »naslednje za tebe«.« En sam deljeni tok pomeni, da vsi poslušalci istočasno slišijo isto — skladbo izbere DJ, ne posamezen uporabnik. Glasba prihaja iz lastne knjižnice lastnika (Navidrome/Subsonic API), ne iz storitev tretjih.

Številke (pridobljene iz strani repozitorija in arhivske tarže, ker je bil GitHub API iz tega okolja rate-limitiran): 1.445 zvezdic, 126 forkov, ustvarjen 2026-05-11, izdaja v1.27.0 z 111 izdajami (release-please, približno vsakih 1–4 dni). License je **MIT** (© 2026 Parminder Klair), kar pomeni, da so ideje prosto uporabne, obenem pa jezikovno **samoangleški** projekt brez i18n plasti — kar je za slovenski Radio Clyde strukturna prednost naše implementacije.

Poslovni model je pomemben za razumevanje obsega: MIT jedro je financirano s gostovanimi storitvami (SUB/WAVE DJ Brain — merjeni LLM ključ »od £5/mesec«; SUB/WAVE Hosted — `yourname.getsubwave.com`) in s plačljivimi aplikacijami v App Store/Google Play. README izrecno trdi, da programska oprema ostane popolnoma brezplačna — a to je klasična odprtokodna lijak z zgoraj zaslužkom, ne čisti hobi projekt.

### 2.1 Tehnološki sklad (potrjeno iz Dockerfile in package.json)

Zvočna veriga: **Liquidsoap 2.4.6** (pinan na digest, celoten mikser v enem 2.445-vrstičnem `radio.liq`) in **Icecast-KH** v enem `broadcast` kontejnerju s supervisor vstopno točko, ki umre, če kateri koli od obeh umre; Caddy kot robni posrednik na enem samem portu 7700. Krmilnik: Node 22, TypeScript ESM, Express 5, Zod 4. Splet: Next.js 16.4, React 19.3, Tailwind 4, Radix UI, three.js (za »Observatory«). Aplikacija: Expo 57 / React Native z Dynamic Island podporo. Analizator: ločen Python 3.12/FastAPI sidecar z librosa (BPM, tonalnost, detekcija začetka/konca, glasnost) in opcijsko torcho (CLAP vgrajevanja + Demucs ločevanje vokalov za »stem blends«).

LLM plasti je izmenljiva ob izvajanju (9 ponudnikov: Ollama kot privzeti, Anthropic, OpenAI, Google, DeepSeek, OpenRouter …); TTS ponuja 6+ mehanizmov (Piper privzeti, Kokoro, Chatterbox kloniranje glasu, OpenAI, ElevenLabs, Gemini, oddaljeni HTTP). Podatkovna baza je **SQLite + JSON datoteke stanja** — brez zunanjega strežnika baze, kar je tudi njegova glavna omejitev obsega (dokumentiran stall pri 150.000 skladbah v knjižnici).

### 2.2 Arhitektura: datotečni pogodbeni IPC

Najbolj inženirsko vreden vzorec celotnega projekta: krmilnik in Liquidsoap komunicirata **izključno prek datotek v deljeni `state/` mapi**. Krmilnik piše `next.txt` (1,0 s poll → `dj_queue`), `say.txt` (govorjeni WAV, močan duck 0,22), `intro.txt` (napoved, rahel duck 0,30), `jingle-now.txt`, `sfx.txt`, `auto.m3u` (obalna plejlista) in nastavitvene datoteke; mikser pa piše oznake nazaj (`now-playing.json`, `voice-playing.json`, `music-starved.json` …). Invarianta iz CLAUDE.md: *»Liquidsoap bere; krmilnik samo piše«*, en pisec na datoteko, serializirani handoff-i. Nadzor (skip, reload) gre prek Liquidsoap telnet na :1234.

To je namenoma »Unix način« — brez vtičnic, brez čakalnih vrst sporočil, vsako stanje je človeku berljiva datoteka, ki preživi ponovni zagon. Radio Clyde že ima del tega vzorca (now_playing.m3u + now_playing_track.json kot pogodba z Liquidsoapom), vendar je SUB/WAVE ta pogodba povzel do konca in jo dokumentiral kot javni API za vse odjemalce — tudi namizni Zig odjemalec in MicroPython mini-predvajalnik na Pico 2 W brata iz istih končnih točk.

### 2.3 DJ zanka in degradacijska lestvica

`queue.ts` (4.952 vrstice) sproži `dj-agent` ob vsakem začetku skladbe (poll 1,5 s). Izbira skladbe ima dva načina: **Track Shortlist** (deterministična predizbota 40 kandidatov z utežmi MOOD 12 / EXPLORE 8 / PLAYLIST 6 / STARRED 6 / RECENT 4 / FREQUENT 4, nato LLM samo izbere) in **Agentic Tools** (LLM dobi 27 orodij iskanja: `search-by-sound` prek CLAP, `deep-cuts`, `tracks-toward-journey` …). Okoli izbire so stražarji: artist-guard, album-guard, genre-guard, circuit breaker, »Musical Leanings« revizijski prehod in **utemeljevanje obrazložitve izbire** (issue #1979: »obrazložitev opisovala drugo skladbo«).

Najbolj poučna je **degradacijska lestvica, ki nikoli ne utiša postaje**: dnevni žetonovski proračun ima mehk stopnjo (80 % → cenen bazo izbirnik, brez neobveznega govora) in trdo stopnjo (brez LLM → obala na `auto.m3u`), izpad LLM → breaker + stanjski izbirnik, izgladovanje glasbe → dead-air guard `fallback([music, emergency])` s 30-sekundnim rožnatim šumom. To je točno tisti razred odpornosti, ki ga ima Radio Clyde že po zasnovi (deterministični skripti ne morejo »izgubiti žetonov«), a SUB/WAVE ga eksplicitno inženiri vsako stopnjo ločeno — vredno omeniti v naši dokumentaciji odpornosti.

### 2.4 Prehodi med skladbami — brez-AI del, ki ga lahko povzamemo

Analizator meri za vsako skladbo BPM, tonalnost, glasnost in **kako se skladba konča** (fade ali trz» cut). Iz tega: crossfade-i se oblikujejo glede na realen konec izhodne skladbe, **stem blends** mešajo Demucs-ov rep izhodne skladbe v glavo prihajajoče, **vocal-runway** ne dovoli DJ-ju govoriti čez peto intro skladbe, glasnost se prilagaja na obeh straneh prek izračunanega `resolveGainDb` (nikoli surovi LUFS). Vsa ta tehnika je **neodvisna od LLM** — je čisto analiza signalov. Prav ta del bi Radio Clyde dvignil s knjižnico `autocue` (glej prilogo, Moonbase59/autocue: JSON cue-in/cue-out točke, detekcija tišine, EBU R128 normalizacija) brez kakršnega koli PyTorcha.

> **STATUS — IMPLEMENTIRANO (P3 #11, 2026-10-24; kodna polovica — boxova nadgradnja = docs/liquidsoap-upgrade.md).** Prehodi sweep/washout/dissolve so vzeti iz SUB/WAVE-jevega produkcijskega `radio.liq` (v1.27.0, 2.445 vrstic, prebran prek codeload tarže) in vsi konstanti ohranjene dobesedno — merjene so na zraku na istem motorju, kamor se nadgrajujemo. Koda: `liquidsoap/dj_transitions.liq` (cela vsebina za `%ifversion >= 2.4.6` — 2.4.4 ima O(n) pregled ure, 2.4.5 odvrne delni okvir po crossu, oboje SUB/WAVE merjeno; naš 2.2.4 ima še živo potrjen bug `fade.out`) in vrata v `radio.liq`: nizko-nivojski `cross(duration=dj_transition_buffer, persist_override=true, dj_transition, radio)` — `crossfade()` ovijalnik ignorira callback po preprostem prehodu (njihov komentar dobesedno). Odkloni od vira, vsi o naši pogodbi: **(1) trije efekti, ne šest** — chop/exit-loop/blend/stem potrebujejo BPM/beat-fazo/stem analizo, kar je proti arhitekturi brez AI; **(2) imaging nikoli mešan po ZGRADNJI** — stingeri/ID/postelje/nujna podlaga sedijo NAD crossom, medtem ko je SUB/WAVE svoje jingle ščitil z zastavico (#1565); **(3) seam z govorom/jinglom ostane TRD REZ** prek `source_tag` pošiljke (P2 #5 pogodba, director/playlist.js) — lekcija 2026-07-28, ko je poskus crossfade() slišno porezal DJ-ja; **(4) brez cross-žigov** — buffer je en literala (3,5 s, vrednost iz uravnanega poskusa 2026-07-28), d pa se meri iz dejansko medpomnjenega (`source.remaining`); **(5) scrobble registriran NAD crossom** (replay odhajajočih metapodatkov sicer sproži handler dvakrat na prehod — njihova meritev, #5360/#5379). Žigovanje: `src/liquidsoap/stampTransitionFlags.js` (CLI set/clear/only/list, idempotentno, `liq_sweep`/`liq_washout`+`liq_washout_delay`/`liq_dissolve`, prednost washout > dissolve > sweep uveljavljena v mešalniku). Motorne omejitve iz vira ohranjene in testirane: `comb` ne `echo` (echo je bitni passthrough), `filter.rc` ne SVF/iir, `mode="high"` pokvarjen → odštevalni HPF (suho − nizkoprepustno), ENA odštevalna operacija za vse štiri dissolvepike (#1565: per-tap oblika je na eni niti stalled clocka), ovojnice prek `source.elapsed()` (avdio čas). Migracija callbackov 2.4.0 je del istega pull zahtevka, vsi dvojni zapisi za `%ifversion` vrata: `source.on_metadata` (funkcija odstranjena v 2.4.6 — preverjeno v deprecations.liq, ostaja samo ne-kvalificirani alias), `blank.detect` (pozicijski handler + `on_noise=` odstranjen, »could not be updated in a backward-compatible way« — metodi `on_blank`/`on_noise` preverjeni v noblank.ml `~callbacks`), `source.on_frame` (deprecated alias). Testi: `test/djTransitions.test.mjs` (25: ravnotežje vrat, vrstni red slojev nad/ pod crossom, pogodba seam-ov, prednost, envelope dobesedno, ENA odštevalna operacija, prepovedani operatorji; Node polovica obnašalna). npm test 275/276 (+1 skipped živi piper; prej 250/250). Živa preverba na boxu OBVEZNA pred zrakom: `liquidsoap --check radio.liq` z 2.4.6 binarno (edina preverba, da vrata dejansko odprejo), potem po korakih docs/liquidsoap-upgrade.md — vključno s povratnim korakom (preklop binarne, vrata se sama zaprejo). ŽIVVALIDACIJA NA PRAVIH BINARKAH (isti dan, brez boxa): uradni Docker binarki v2.2.4-1 in v2.4.6 izvlečeni v userspace (anonimen registry pull + lasten loader); `--check` EXIT 0 na OBAJH, `--describe-sources` (celoten graf) EXIT 0 na 2.4.6, živa zagona 12–75 s brez napak, in efekti DEJANSKO na zraku: washout 2× (tap=0.45 s, d=2.5 s), dissolve (d=3.48 s), speech seam trd rez. Tri odkritja iz živih preverb, vsa popravljena: (1) `synchronous` je OBVEZEN argument callback metod; (2) cross zavrača method-razširjene vire (fade.in obesi record metode → notranji `(Dynamic, None)`, cross zahteva `(Static, None)`) — rešen z `source.dynamic(self_sync=false, {radio})` pred crossom, SUB/WAVE-jev lastni vzorec (njihov ~vrstica 401); request.dynamic poroča `(Static, None)` in je nedolžen, zahtevki ostanejo znotraj prekrižane verige; (3) post-cross `on_metadata` se na 2.4.6 NE sproži dvakrat (#5360 + deduplicate=true ovojnica odstrani replay — živo: META: AAA, META: BBB, en dogodek na skladbo), scrobble pod crossom pokrije tudi zahtevke. Podrobno: docs/liquidsoap-upgrade.md.

---

## 3. Ekosistem okoli jedre

### 3.1 `getsubwave/web-player` — forkabilen referenčni odjemalec

React 19 + Vite 6 + TypeScript 5.7 + Tailwind v4, brez routerja in brez state knjižnice — čista SPA, ki zgradi statični `dist/`. Njegova nosilna ideja je **strog razcep podatkovne in prezentacijske plasti**: `src/lib` (tipi, `stationClient`, formatiranje) in `src/hooks` (`useStationFeed`, `usePlayer`, `useElapsed`, `useRequest`, `useSchedule`, `useMediaSession`) so »obdrži«; `src/components` so »prepiši«. Enojna konfiguracija: `VITE_STATION_URL`, pečena ob gradnji.

**Pogodba API (javna, dokumentirana, CORS `*`, brez avtentikacije):** `${url}/api` (JSON) + `${url}/stream.mp3` (zvok) + `/api/cover/:id` (ovitki). **Ni websocketov — poll, ne subscribe**: 5-sodni poll `/now-playing` + `/state` + `/session`, pavza pollinga, ko je zavihek skrit, obdrži zadnji dobri posnetek ob napaki. Končne točke: `/now-playing`, `/state`, `/session`, `/schedule`, `/cover/:id`, `/health`, `POST /request`, `GET /request/:id`; opcijski tokovi `/stream.opus`, `/stream.flac`, `/stream.aac`. Živi odziv `/now-playing` vsebuje akustične metapodatke skladbe (BPM, tonalnost `10B`, razpoloženja, energija), **kontekst** (dnevni del, vreme z izgovorjenim časom »pol dva ponoči«, sezona, praznik, aktivna oddaja s persona + gosti + uredniški »episodeAngle«), DJ (ime/slogan/avatar), `listeners.current/peak` in `stream` (bitrata, bufferSeconds, zastavice formatov).

**Radijska semantika v kodi:** brez iskalne vrstice, brez skip, brez na-poslušalca naključja; MediaSession naslednje/prejšnje/iskanje **namenoma ni povezano** — »čujen dvotap nekoga na slušalkah ne sme zamenjati pesmi za celo sobo«; predvajanje zahteva »prilagodi se« gesta; ob vsaki spremembi skladbe se ura ponovno sinhronizira. To je enaka filozofija, kot jo ima Radio Clyde v hero predvajalniku, vendar SUB/WAVE to izrecno dokumentira kot **API omejitev**, ne le UI odločitev.

### 3.2 `getsubwave/subwave-desktop` — nativni odjemalec v Zig-u

Presenetljivo: ne Electron, ne Tauri — **Vercel Native SDK** z deklarativnim `.native` označevanjem in **Zig 0.16** logiko, brez brskalnika in brez WebView. Lasten FFT spekter (32 pasov z attack/decay balistiko), izbira formata toka glede na zmožnosti platforme (AVPlayer / Media Foundation / GStreamer) s treh-poskusnim padajočim rezervnim mehanizmom, teme se posodabljajo iz `/api/themes` vsakih 30 s, **Cmd/Ctrl+K preklopnik postaj** (MRU + javni imenik `stations.json`), pavzačas 15–90 min, mini predvajalnik v ločenem oknu, **obvestila o spremembi skladbe, ki nadomeščajo po ID-ju** (novo obvestilo zamenja prejšnje, ne kopičenja), opt-in Discord Rich Presence, poštena dokumentirana omejitve (brez MPRIS/medijskih tipk — SDK nima površin; »ni ničesar poštenega, na čemer bi zgradili izbirnik izhodov«). Distribucija: podpisani in notarizirani DMG, Windows build **na resničnem Windows runnerju**, AUR paket; CI **razgrajuje artefakte**, da preveri `-Dcpu=baseline` pin (poslali so exe, ki je zahteval AVX-512).

### 3.3 Živa postaja getsubwave.com — oblikovni jezik

Široka »brošura/novine« metafora: naslovna rubeža »VOL. 1.27.0 · NO. —«, slogan **»✦ No skips · No shuffle · Just radio ✦«**, razdelki kot »PART ONE…SIX«, slike kot FIG./PLATE No., kolofon »— 30 —«. Poslušalcu: ovitek, naslov/izvajalec/album/elapsed, valovna oblika, in **dva predalka** — Timeline (vrstni red + nedavno predvajano) in **Booth (dnevnik vseh besed, ki jih je DJ izgovoril)**. Osem izgledov (Classic, Platter — delujoč gramofon, TTY — znakovni, …) × osem tem; vsak poslušalec izbere svojega, oddaja pod njim je enaka. Interakcija: zahtevki v naravnem jeziku »Pokliči postajo, kot si nekoč« — instant potrditev »Got it — taking it to the booth«, ujemanje teče v ozadju, čipsi predlogov so zgrajeni iz trenutnega izvajalca, časa dneva in vremena, ob predvajanju DJ lahko izgovori tvoje ime.

### 3.4 Preostanek organizacije `getsubwave`

Šest javnih repozitorijev: `web-player`, `subwave-desktop`, **`community`** (veščine/osebe/oddaje/imena postaj kot enodatsotečni prispevki; CI sestavi `catalog.json`; vsaka delujoča postaja ga živo obvladuje iz GitHub raw z **degradacijo na prazen katalog, nikoli na tišino**; »vse, kar je združeno tukaj, se pojavi v adminske plošče vsake postaje brez čakanja na programsko izdajo«), `audiomuse-import` (uvoz obstoječe analize moods/BPM/key), `omarchy-subwave` (Arch/Hyprland vtičnik) in **`pico-subwave`** (MicroPython mini-predvajalnik na Raspberry Pi Pico 2 W; preskok je operaterski preglasanj z 1-sekundnim držanjem, »ker preskoči za vse poslušalce«).

### 3.5 Združevanje (Reddit, HN, YouTube)

Nit r/coolgithubprojects: 168 točk, 95 % pozitivnih, 29 komentarjev. Pohvale: »bilo je na tem, da bi dali ne-glas, ampak dejansko zanimivo orodje«; »pravljica ljubezni in umetniško delo … podrobnosti vmesnika so sublimne«; »seznam funkcij je iskreno nesmiseln«; en uporabnik poganja 5 AI voditeljev s kloniranimi glasovi nad SSHFS montiranim state. Kritike: zmeda okoli nastavitve LLM/embedding, ne teče na stari strojni opremi, **pritožbe po avtentikaciji poslušalcev** (avtor: PR že obstaja), zahteve po PWA, Spotify (zavrnjeno — TOS), Plex (PR v teku), **Android Auto zgrajen in umaknjen** — Googlova politika zavrne medijske aplikacije, ki uporabljajo TTS za branje vsebine, kar je dobesedno to, kar počne AI DJ. Na HN je omenjen v niti Tunecat kot »bolj osebna razširjena« priporočilo; YouTube demo Techdox (~9,7k ogledov).

---

## 4. Popolna primerjava funkcij: SUB/WAVE ↔ Radio Clyde

Radio Clyde stanje preverjeno lokalno na main `3b04491` (public/ 151+626+467 vrstic, studio 11 pogledov, 72/72 testov). Opomba: **nativni android-tv/ in android-mobile/ odjemalca sta del našega repozitorija od začetnega commita** (ExoPlayer, poll 12 s, `/api/art/:ratingKey`, `/api/weather` dodan za aplikacijo) — to je funkcionalni ekvivalent SUB/WAVE-jevih tržnih aplikacij, ki jih imamo že danes brez trgovine.

| Področje | SUB/WAVE | Radio Clyde | Boljši |
|---|---|---|---|
| Jedro izbire glasbe | LLM (2 načina) + 27 orodij | deterministična pravila + koledarji + fillerRotation | **RC** (predvidljivo, 0 stroškov) |
| DJ govor | LLM + 6+ TTS, kloniranje glasu | Piper SI predloge + vnaprej generirani posnetki | ni primerljivo (namenoma) |
| Prehodi skladb | analiza konca, stem blends, R128 | preprost crossfade | **SW** |
| Poslušalčev UI | 8 izgledov × 8 tem, PWA, MediaSession, Booth | 1 tema, hero + 3 zavihki, a11y, SI | **SW** (obseg) / **RC** (iskrenost, jezik) |
| Zahtevki | naravni jezik + instant ack + čipsi | obrazec + flood control fail-closed + moderacija | **SW** (UX) / **RC** (varnost) |
| Ovitki | iz Navidroma + akustični trakovi | Plex art / lokalni (omejeno) | **SW** |
| Spored | 7×24 mreža + osebe + gosti + programme | 7-dnevna mreža z datumsko-škopiranimi ZDAJ/NASLEDNJI oznakami | izenačeno |
| Analitika poslušalcev | beaconi kot soljeni hashi, 60-dnevni vedri, peak | JSONL vzorčenje 60 s + vpliv po skladbah + živi probe | **SW** (seje, geolokacija, peak) / **RC** (vpliv po skladbah z minCoverage pravili) |
| Diagnostika | DJ Doc + debug nedavnih LLM klicov | Diagnostics (proces/Icecast/playlist/repeat/error ring/logi) | **RC** (iskreno brez LLM zmede) |
| Multi-format tokovi | MP3 + Opus/AAC/FLAC stikala | en sam tok | **SW** |
| `.pls`/`.m3u` za strojno opremo | da (Sonos/VLC/avto) | ne | **SW** |
| Zasebna postaja | geslo predvajalnika + auth na mount | Basic Auth na vsem (tudi poslušalec) | **SW** (ločitev) |
| Arhivi, podcasti | obhodni MP3 arhivi | ne | **SW** |
| Scrobbling | Last.fm + ListenBrainz | ne | **SW** |
| Nativne aplikacije | iOS/Android (trgovine), Zig desktop, Pico | **android-tv + android-mobile** v repozitoriju | izenačeno (RC brez trgovin) |
| Skupnostni katalog | merge-to-air catalog.json + zemljevid postaj | ne | **SW** |
| I18n | samoangleški | **slovenščina privzeta** | **RC** |
| Testi v CI | CI poganja samo lint (testi ročno!) | 72/72 v testni skripti, regresijski testi razredov napak | **RC** |
| Ponovljivost vsebine | zvezdne težave (#1975/#1977/#1979: napačne najave, obala ponavlja) | hash-izbira predlog + ledger proti ponavljanju | **RC** |

---

## 5. Kje je SUB/WAVE boljši (konkretno, z akcijami)

### 5.1 Poslušalčeva strana — največje vrzeli Radio Clyde

1. **MediaSession + PWA.** Naš web UI (`public/app.js`) nima `navigator.mediaSession`, nima `manifest.json`, nima service workerja (grep potrjuje). SUB/WAVE dobi iz tega: nadzor na zaklenjenem zaslonu, artwork v sistemskem predvajalniku, namestitvijo PWA. Dejstvo, da imata android odjemalca PlaybackService z medijskimi obvestili, web uporabnikom tega odreka. Akcija: MediaSession (energija ~50 vrstic) + manifest + osnovni SW (~1 dan dela).
2. **`.pls`/`.m3u` končne točke** za Sonos/VLC/avto — dvema statičnima odgovoroma z URL-jem toka. SUB/WAVE to trži kot »starodavno strojno opremo«. Akcija: `GET /listen.m3u` + `/listen.pls` (~30 vrstic, brez odvisnosti).
3. **Vršni števec poslušalcev.** Naša analitika beleži vzorce vsakih 60 s, kar pomeni, da vrhovi med vzorčenjem niso ločljivi in `peak` ni izpostavljen. SUB/WAVE v API javlja `listeners.current` **in** `peak`. Akcija: izračun peak iz obstoječega JSONL + `max` ohranjanje v ledgeru, brez nove infrastrukture.
4. **Analitika po sejah, ne po vzorčenju.** AzuraCast in SUB/WAVE rekonstruirata **seje poslušalcev** (povezava/odjava po IP z GeoLite2 mapi) z razlikovanjem Icecast admin seznama poslušalcev. Naše vzorčenje števil izgubi obrat (kdo je odšel med pesmijo ne more vezati na skladbo čez več vzorcev). Akcija: poll `status-json.xsl` vsebuje `listener` seznam z IP/time — razlikovanje zaporednih vzorcev nam da seje brez nove odvisnosti.
5. **Priporočilni čipsi za zahtevke.** Naš obrazec za zahtevke je prazen vhod; SUB/WAVE predlaga čipse iz trenutnega izvajalca, ura dneva in vremena — pri nas je to čisto deterministično izračunljivo (iz /api/now-playing + /api/weather). Akcija: 3–4 statični čipsi »Skratka v tem vremenu« / »Iz istega desetletja kot zdaj igra«, filtrirani iz realne knjižnice.
6. **Booth / dnevnik izrečenega.** Booth je »log vseh besed DJ-ja« — poslušalcu daje občutek živosti, Ownerju pa revidiralnost. Radio Clyde **ima podatke** (aired history + voice segmenti v pipeline), a jih ne javlja poslušalcu. Akcija: javni `/api/booth` (ali razširitev /api/history) z označenimi govorjenimi segmenti + malen predal v UI.

### 5.2 Zvočna veriga — brez-AI prevzem

7. **Cue točke in glasnost.** autocue vzorec (JSON cue-in/out, detekcija tišine, EBU R128) je najvišja kakovost zvočna izboljšava, ki jo lahko naredimo brez torcha. SUB/WAVE-jevi lastni issue-ji potrjujejo vrednost: #2015 (comb-filter zareza od napačnega cue-in), #1696 (192 kHz jingle ne predvaja). Akcija: P2 — enkratna offline analiza knjižnice → `cue_points.json` → Liquidsoap `cue_cut`.
8. **Multi-format tokovi.** MP3 vedno + Opus/AAC po izbiri v admin; our single mount dela vse, a troši pasovno širino in ne ponuja FLAC poslušalcem. Akcija: P3 — drugi encoder v radio.liq + izbira v UI (delo: 1 večer).

### 5.3 Owner/ops

9. **Dnevni proračun kot koncept.** Že imamo iskrenost pravila, nimamo pa **eksplicitne degradacijske lestvice v dokumentaciji** (mehko/trdo/obala/nujnost). SUB/WAVE to objavi kot javno jamstvo (»ko žetoni zdijo, glasba še igra brez pripomb«). Akcija: dokumentirati naš obstoječi padajoči rezervni mehanizem v eni strani (weather izpada → chip skrit; voice izpada → espeak; plex izpada → lokalni; Icecast izpada → {listeners:null}).
10. **Onboarding čarovnik + namestitvena komanda.** radio-dj (priloga) ima `install` ukaz, ki registrira systemd enoto; SUB/WAVE ima `subwave setup` CLI in onboarding čarovnik, ki vse zapiše v state/settings.json. Naš DEPLOYMENT_GUIDE je ročen. Akcija: P2 — `npm run onboard` (interaktivni q&a → config.json + systemd enota + zdravstveni pregled verige).

---

## 6. Kje je Radio Clyde boljši (pošteno obračanje)

1. **Ni LLM nevarnosti.** SUB/WAVE-jevi issue-ji so katalog razreda napak, ki jih deterministični sistem po definiciji ne more imeti: izbirnik vrne nič (#285), obrazložitev opisuje napačno skladbo (#1979), obala ponavlja pravkar predvajano (#1977, #1950), revizijski prehod bere »Avoids…« kot pozitivno preferenco (#2019), oddaljeni TTS govori vrstico sovoditelja v napačnem glasu (#2047). Naš hash-izbor predlog in ledger ne moreta »zaveden«.
2. **Stroški.** AI DJ je metered spend za vedno (issue #353 »AI Usage cap« je bil top-zahteva). Radio Clyde ima 5 produkcijskih odvisnosti in 0 API ključev.
3. **Jezik.** SUB/WAVE je samoangleški v vsebini (prompti, veščine, osebe, segmenti — brez i18n). Radio Clyde je slovenski po zasnovi, s WMO slovarjem in sklanjanjem števcev poslušalcev (1 poslušalec / 2–4 poslušalca / 5+ poslušalcev) — to ni prevzemljivo z nastavitvijo.
4. **Testi so dejansko v CI-poteku.** SUB/WAVE poganja stotine `.test.ts`, a CI po dokumentaciji **poganja samo lint**; kakovost počiva na disciplini. Radio Clyde: 72/72 testov vsak push, vključno z regresijskim testom za razred napak (scheduler `?.` skeniranje vira).
5. **Manjša kodna baza = revizijska.** SUB/WAVE: 2.207 datotek, ~300 nastavitvenih ključev, `queue.ts` 4.952 vrstic. Radio Clyde: celoten public/ je 1.244 vrstice, celoten strežnik preverljiv v enem popoldnevu. Za samostojnega operaterja je to razlika med »razumem svojo postajo« in »zaupam svoji postaji«.
6. **Ponavljanje je rešeno deterministično.** Njihova obala je imela bug, da ponavlja pravkar predvajano; naš fillerRotation ledger je regresijsko testiran (0 identičnih skladb v zaporednih generacijah na fiksturi) in Diagnostics/Library ponavljajoče prekrškarce **označujejo rdeče, ne skrivajo**.
7. **Nativni Android odjemalca brez trgovine.** android-tv (Leanback, ExoPlayer, analogna ura, vreme) in android-mobile (PlaybackService z medijskim obvestilom) sta od začetnega commita — SUB/WAVE za to rabi dve trgovini in notarizacijo.

---

## 7. Priporočila (posodobljen P1/P2/P3, združeno s konkurenčno analizo)

Prejšnja analiza je postavila P1 #1 analitiko ✓, #2 javni števec ✓, #4 TuneIn/Discord ✓; ostajata #3 imaging sloj in #5 vgradi predvajalnik. Globja analiza SUB/WAVE to listo **razširja** (novi predlagani, ne zamenjuje obstoječih):

**P1 (ceno, visok učinek na poslušalca):**
- **MediaSession + manifest + osnovni PWA** (SW cache-only za statiko; tok nikoli cache)
- **`GET /listen.m3u` + `/listen.pls`** (Sonos/VLC/avto, ~30 vrstic)
- **Vršni poslušalci** v /api/listeners + studio Analytics (iz obstoječega JSONL)
- **Priporočilni čipsi v zahtevkih** (deterministični: izvajalec/ura/vreme iz realnih API-jev)
- #5 vgradi predvajalnik ( že planiran; SUB/WAVE-jev Talk-Wave prikazuje 2-vrstični embed pattern: card/pill/docked/popup)

**P2:**
- **Sejna analitika** (razlikovanje Icecast admin seznama poslušalcev → seje + geolokacija prek GeoLite2; AzuraCast/morganfreeman vzorec) + #3 imaging sloj
- **Booth/Dnevnik** javno (izrečeni segmenti iz aired history)
- **onboarding ukaz** (`npm run onboard` → config + systemd + zdravstveni pregled)
- **autocue cue točke + EBU R128** (offline analiza knjižnice → cue_points.json)

**P3:**
- **Multi-format tokovi** (Opus drugi mount), **teme/izgledi** (CSS bloki kot SUB/WAVE theme tokens), **arhivi po urah** (za podcast RSS — to se povezuje s P2 podcastRSS iz prejšnje analize), **zasebna postaja način** (ločeno geslo predvajalnika od studio auth — rešuje napetost, da naša Android aplikacija pošilja Basic auth povsod).

**Ne povzemati:** skupnostni katalog (nismo platforma), MCP strežnik (proti »brez AI« načelu), observatory/three.js (lepotni presežek), LLM/token ticker (N/A — naš ekvivalent bi bil »voice engine status« trak, ki ga Voice view že ima).

---

## 8. Priloga: širša pokrajina (iskanje naprej — »mogoče se kaj več najde«)

Zahtevano je bilo iskati naprej. Poleg SUB/WAVE so pregledani: **AzuraCast** (~4.070★, AGPL) — zlati standard analitike (seje poslušalcev, geolokacija, per-song impact, SoundExchange poročilo), vsak UI akcija je API klic s per-user ključi, NGINX proxy toka na 80/443; **LibreTime** (~937★) — Smart Blocks (kriterijsko generirane bloke: »12 ambient skladb < 6 min«) in vir-prioritetna padajoča veriga (show → master → security); **Rivendell** — RDCatch planiran snemalnik (idealno za vremenske/novičarske prevzeme); **WRIT-FM** (~382★) — taksonomija segmentov (deep_dive, news_analysis iz RSS, mailbag, music_essay) + editorial ledger + »min vsebine na slot«; **radio-dj** (~60★, Go 8,7 MB) — onboarding/namestitev + sidechain ducking + veščine kot urejanje besedilnih datotek; **Talk-Wave** (~9★, SUB/WAVE spremljevalec) — 2-vrstični vgradi predvajalnik, programski vodnik kartica, per-feature dovoljenja, »receipt cards« revizija akcij; **jailsonsb2/RadioPlayer** (~36★) — zabrisan ovitek kot ozadje, fade glasnosti, MediaSession, PWA, env-var generirana konfiguracija; **PawTunes** (~69★) — cevovod ovitkov (Spotify/iTunes/LastFM → preveri → cache) + multi-bitrate izbira; **lebkuchen-fm** — Discord-upravljana »multiplayer radio«; **Airstation** (~349★) — **HLS dostava** prek ognjenih zidov.

**TOP-10 izposojljivih idej čez celotno pokrajino** (vir v oklepaju): 1. sejna analitika poslušalcev z geo (AzuraCast/morganfreeman) 2. 2-vrstični vgradi predvajalnik + programski vodnik kartica (Talk-Wave) 3. onboarding + namestitev ene komande (radio-dj) 4. taksonomija segmentov + uredniški bazeni vsebine (WRIT-FM — deterministično prevedljivo v naš template sistem) 5. avtentificiran REST API s per-user ključi, owner UI zgrajen nanj (AzuraCast) 6. HLS ali 80/443 proxy dostava toka (Airstation/AzuraCast) 7. ovitkovski cevovod + MediaSession + zabrisano ozadje + fade (jailsonsb2/PawTunes) 8. autocue cue/R128 (Moonbase59/autocue) 9. Smart Blocks (LibreTime) 10. skupnostni katalog z varno degradacijo (getsubwave/community — v prihodnosti, če postanemo platforma).

---

## 9. Metodologija in viri

Glavni repozitorij prebran prek codeload tarže (2.207 datotek) ob rate-limitiranju GitHub API; README, CLAUDE.md, docs/concepts.md, izbrani izvorni datoteki (`queue.ts`, `radio.liq`, `dj-agent.ts`, `scheduler.ts`, `session.ts`, `.env.example`, built-in SKILL.md), issue seznam, izdajah. Ekosistem: getsubwave/web-player (README + živi API probi), subwave-desktop (README + izdaje), getsubwave.com + /listen + /api/now-playing živi odziv, organizacijska stran, /news, /stations, /apps, /manual. Skupnost: dve Reddit niti rešeni prek Arctic Shift arhiva (www/old.reddit blokiran), HN Algolia, YouTube naslovi. Širša pokrajina: GitHub README/dokumentacija AzuraCast, LibreTime, Rivendell, WRIT-FM, radio-dj, Talk-Wave, jailsonsb2/RadioPlayer, PawTunes, Airstation, lebkuchen-fm, autocue. Radio Clyde stanje: lokalni main `3b04491` (grep + branje public/, src/server/, liquidsoap/, docs/). Vse številke zvezdic približne ob dnevu analize.
