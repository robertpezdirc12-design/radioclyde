# Vmesnika Radio Markec: admin (Studio) vs. poslušalec — inventar, primerjava z najboljšimi

Analiza po P5 #2 (datum: 25. 10. 2026). Vsak podatek prihaja iz kode
(`public/studio/`, `public/app.js`, `src/server/*Api.js`) — nič ni ugibanje.
Krajišče analize: kaj vsak vmesnik ZNA danes, kaj imajo najboljše platforme,
kje so prave vrzeli in kateri naslednji korak prinese največ.

## 1. Studio (admin) — devet pogledov, ena površina za pisanje

Dostop: HTTP Basic Auth (`studioAuth.js`), ločen od javnega sajta
(namerno — uporabnik streame ne sme pisanja). Brez TLS na boxu (znana
omejitev, obljubljen Cloudflare Tunnel). Pogledi:

| Pogled | Funkcije | Piše | Bere |
|---|---|---|---|
| **On Air** | status živo/nič, št. poslušalcev, naslovnica, napredek skladbe, Skip, Force Next Show, prihajajoče, nedavno predvajano | skip + force-next | now-playing, ledger |
| **Shows** | iskanje, nov/edit/del oddaje: brief (osebe, rubrike kviz+vreme, ponovitveno okno, izbor skladb, ton, premiki) | CRUD brifov | datoteke oddaj |
| **Schedule** | tedenska mreža: vleci/umeni/zamenjaj/raztegi termin, klik = dodeli ali briši | station.json | urnik |
| **Prompts** | skriptni review prompt, osebe (besedila) | prompts.json | — |
| **Requests** | filtriraj po statusu, odobri/zavrni z opombo | requestsStore | zahtevki |
| **Library** | zdravje rotacije iz REALNE zgodovine, iskanje po knjižnici | nič | aired.jsonl, knjižnica |
| **Analytics** | 24h/3d/7d, število poslušalcev, graf, vpliv skladbe (Δ start→konec), pravila meritve | nič | ledžerja |
| **Voice** | samo branje: način, Piper, klipi, pregenerirani sloti | nič | config + disk |
| **Diagnostics** | proces, tok, playliste, ponovitveni pregled, obroč napak, repi dnevnikov | nič | sonde |

Zasnova: skoraj vse je **samo za branje**; pisanje je namenoma ozko
(brifi, urnik, prompts, zahtevki, dve živi akciji). Nič ne spreminja
config.json na živo — menjava načina glasu je restart po dogovoru.

## 2. Poslušalski vmesnik — predvajalnik + spored + zahtevki

`public/index.html` + `app.js` (slovensko, PWA: manifest + service worker),
plus `embed.html` za vstavitve:

- **predvajalnik**: predvajaj/tiho/glasnost, napredek skladbe, NASLOVNICA,
  »DJ govori« indikator, LIVE čip, vremenski čip, čip »nas posluša X«,
  eksplicitna stanja napak (nikoli lažnih podatkov),
- **spored**: tedenska mreža v lokalnem času + prihajajoče + zadnjih 20
  predvajanj,
- **zahtevki**: obrazec (čipi iz trenutne skladbe + nedavnih izvajalcev),
  statusna preverba po ID-ju — vidi TOČNO to, kar studio nastavi,
- **priljubljeni**: localStorage (saj je povedano — strežnik nima računov),
- **downtime** opomba, ko je tok mimo.

Zahtevnost je namenoma nizka: **en zapis** (zahtevek) — vse ostalo je branje.

## 3. Primerjava z najboljšimi

| Zmožnost | Markec Studio | Futuri Post | Radio.co / Airtime Pro | Zeno.FM | Spreaker | SUB/WAVE (referenca) |
|---|---|---|---|---|---|---|
| ZDAJ predvajano + naslovnica | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| Skip / force-next iz brskalnika | ✅ | ✅ | ✅ | delno | ✅ | ✅ |
| Tedenski urnik z vlečenjem | ✅ | ✅ | ✅ | ❌ | n/p | ✅ |
| Upravljanje brifov oddaj | ✅ (brez modelov) | ✅ (LLM) | ❌ | ❌ | ❌ | delno |
| Moderacija zahtevkov | ✅ | ✅ | ❌ | ❌ | ❌ | ✅ |
| Analitika poslušanja + vpliv skladbe | ✅ (Δ po predvajanju) | ✅ (gostejša) | ✅ | ✅ | ✅ | ✅ |
| Glasovni TTS sloj brez modelov | ✅ (Piper) | ❌ (cloud TTS) | ❌ | ❌ | ❌ | ❌ |
| Podcast export + generator + zvok | ✅ (CLI) | ✅ (POST) | ❌ | ❌ | ✅ (jedro) | ❌ |
| Javni RSS feed podkasta | ❌ (skeleton XML) | ✅ | ✅ | ✅ | ✅ | ❌ |
| Predvečerna diagnostika (doctor) | ✅ | ✅ | ❌ | ❌ | ❌ | ❌ |
| as-run / licenčno poročilo | ✅ | ✅ | ✅ | ❌ | ❌ | ❌ |
| Poslušalski računi / push | ❌ | ✅ | delno | ✅ | ✅ | ✅ |
| Reklamski trafik (ad scheduler) | ❌ | ✅ | ✅ | ✅ | ✅ | ❌ |
| Živi mikrofon / voicetracking | ❌ | ✅ | ✅ | ❌ | ✅ | ❌ |

Najboljše platforme zmagujejo tam, kjer je Markec namenoma »samo« radio:
trafik reklam, računi, push, mobilne aplikacije. Markec pa ima štiri stvari,
ki jih povprečna ploščad NIMA: (1) **pogodba poštenih podatkov** — noben
prikaz ne izumi vrednosti, vsako prazno stanje je izpisano; (2)
**determinističen revizjski sled** (aired.jsonl → as-run CSV); (3)
**doctor** — diagnoza PRED oddajo; (4) **celoten cevovod podkasta brez
modelov in brez mesečnega računa za AI**.

## 4. Nesimetrije med vmesnikoma (vrzeli, ki so DANS realne)

1. **Podkasta poslušalec NE vidi.** Studio ima export/generator/zvok (CLI),
   poslušalska stran ničesar — ni strani epizod, ni RSS-ja, ni predvajalnika
   epizod. To je največja nesimetrija: vsebina obstaja, nima naslova.
2. **Studio ne more sprožiti podkasta.** `podcast-gen`/`podcast-audio` sta
   CLI-orodji; brskalniški gumb (»izdelaj današnjo epizodo«) manjka.
3. **Analitika je samo admin.** Poslušalc ne vidi niti anonimiziranih
   »najbolj poslušanih tedna« — podatki so, naslova ni.
4. **Voice je samo-branje po dogovoru** — menjave načina ni niti v studiu
   (restart zahteva SSH); to je verna odločitev, ampak pomeni, da admin
   tega ne more niti zaprositi.
5. **Embed pozna samo now-playing** — brez sporeda/zahtevkov, torej
   vgrajen predvajalnik je slabši od strani.

## 5. Predlagani vrstni red naslednjih korakov (P5)

Status (dopisano pri P5 #4): točke 1–3 so IZVEDENE (javni podkast + RSS +
stran, studijski gumb, javna »najbolj poslušano«) in točka 4 pravkar tudi —
push obvestila ob začetku terminirane oddaje so živa (`push/*` + rute +
opt-in kartica na poslušalski strani + studijski test-gumb, brez novih
npm odvisnosti). Točka 5 ostaja zavestno NE.

1. **Javni podcast naslov** (največji Markec dobiček za najmanj kode):
   serviranje `podcasts/` + RSS z pravim `link`, stran »Podkast« z
   predvajalnikom epizod — `podcast-export` že piše RSS, manjka samo
   objava in stran.
2. **Studio gumb za podkast** — `POST /api/studio/podcast` (enak klic kot
   CLI), prikaz zadnje epizode + stanja zvoka v pogledu Shows.
3. **»Najbolj poslušano« javno** — anonimiziran izvod analytics (top 10
   tedna) na poslušalski strani; krepi zaupanje, nič ne razkriva.
4. **Push/obvestila PWA** — ob začetku terminirane oddaje (service worker
   že je); najprej opt-in.
5. **Trafik reklam / računi / živi mikrofon** — zavestno NE: to so
   platformne funkcije s svojimi ekipami; Markecjeva prednost je prav
   osredotočenost.

Vir števil: koda repozitorija ob commitu P5 #2; primerjave so opisne, ne
ocenjevalne — vsak »✅« pri konkurenci pomeni »zna vsaj osnovno« po javni
dokumentaciji ploščadi.
