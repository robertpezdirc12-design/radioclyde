# Rubrike kot skilli (`skills/<slug>/SKILL.md`)

*Funkcija: zunanja nastavitvena plast za kadenco (in, kjer je bralec splošen RSS odjemalec, tudi vir) rubrik avtomatskega načina. Zasnova je ukradena iz SUB/WAVE-ovega skills mehanizma (`controller/src/skills/loader.ts` + `docs/custom-skills.md`) — radioclyde pa ne potrebuje ne YAML knjižnice ne zaupanja vrat: skilli so podatki v repozitoriju, ne tuja koda.*

## Kaj je skill

»Skill« je ena rubrika avtomatskega načina (vreme, novice, šport, obzorje), opisana z majhno datoteko, ki jo operater lahko ureja. Namen je ozek in pošten: **spremeni kadenco brez dotikanja kode**. Skill določa samo `cooldown` (kako dolgo se odgovor vira predpomni) in pri splošnih RSS bralcih `feed` (naslov vira). Nič drugega — izbira skladb, govor, predloge in kadensa predvajanja ostajajo koda.

## Postavitev

```
skills/
  arso-vreme/SKILL.md      -> rubrični ključ weather
  rtv-novice/SKILL.md      -> rubrični ključ news
  rtv-sport/SKILL.md       -> rubrični ključ sport
  wikidata-dan/SKILL.md    -> rubrična ključa onthisday + onthisdaymusic
```

Ime mape je »slug« po SUB/WAVE-ovem pravilu: `/^[a-z0-9][a-z0-9-]{0,48}$/` (male črke, številke, vezaji; največ 49 znakov; se začne z alfanumeričnim). Mapa, ki se pravilu ne ujema, se pri nalaganju tiho prezre — enako velja za neberljivo ali okvarjeno `SKILL.md`. Vsak slab skill pomeni največ to, da zmaga kodni fallback; oddaja nikoli ne crkne.

## Oblika `SKILL.md`

```markdown
---
name: RTV novice
cooldown: 30m
feed: https://www.rtvslo.si/feeds/novice.xml
---
Proza za operaterja: kaj rubrika bere, od kod podatki prihajajo,
kaj se zgodi, ko vir crkne.
```

Frontmatter je **raven seznam `key: value` vrstic med dvema `---` vrsticama** — točno tista omejena linearna slovnica, ki jo SUB/WAVE dokumentira kot svojo legacy (zavarovalno) različico: brez pravega YAML parserja, brez novih odvisnosti. Vrednosti smejo biti v dvojnih ali enojnih narekovajih (ujemajoč par se odstrani), UTF-8 BOM se odstrani, pri podvojenem ključu zmaga zadnji. Vrstica brez dvopičja in vrstica s `#` se prezrejo. Manjkajoča zaklepna `---` = okvarjena datoteka = ignorirana. Prazna frontmatter (nič uporabnih ključev) se šteje za okvarjeno prav tako — `SKILL.md`, ki ne pove ničesar, ni skill.

| Ključ | Oblika | Pomen |
|---|---|---|
| `name` | 1–60 znakov | Prikazno ime rubrike (če manjka, se privzame ime mape). |
| `cooldown` | `15m` / `2h` / `90s` / golo število | Kadensa predpomnjenja; golo število pomeni **sekunde**. |
| `feed` | http/https URL, brez presledkov | Vir za splošne RSS bralce (novice, šport) — glej tabelo spodaj. |
| `cron` | poljuben niz | **REZERVIRAN: sprejet in ignoriran.** Kadensa predvajanja pri radioclyde pripada `station.json` in urniku, ne skillu. Parser ga sprejme zaradi združljivosti s SUB/WAVE-ovimi skilli; pošteno povedano — še nima pomena. |

Neznani ključi se ignorirajo (naprej-združljivo, kot pri SUB/WAVE). Preveliko ime ali neveljaven URL pomenita le, da se ta ključ odvrže — datoteka ostane veljavna.

### Formati cooldowna

- `15m` → 15 minut, `2h` → 2 uri, `90s` → 90 sekund, `45` → **45 sekund** (golo število = sekunde).
- `0m` je dovoljen in pomeni 0 ms: predpomnjenje se izklopi in vsak klic dejansko sprašuje vir. To je pošteno — operater je tako hotel, klicev na uro pa je le pešlica.
- Smetje (`abc`, prazna vrednost, `-5m`, `2d` — dnevi v tej slovnici niso) → ključ se odvrže, zmaga kodni fallback. Parser nikoli ne ugiba, kaj je operater mislil.

**Odmik od SUB/WAVE:** tam golo število pomeni minute, obstaja pa tudi enota `d`. radioclyde namenoma sprejema samo `s`/`m`/`h`, golo število pa tolmači kot sekunde — sekunda je najmanj presenetljiva enota za golo številko, in to je tu glasno dokumentirano.

## Prednost resolucije

```
eksplicitni parameter klica  >  SKILL.md  >  kodni fallback (stari literali)
```

- Vsaka funkcija v `src/auto/feeds.js` še vedno sprejema `ttlMs` (novice/šport pa tudi `feed`); eksplicitni argument vedno zmaga — obstoječi klici se obnašajo nespremenjeno.
- Nato `skills/<slug>/SKILL.md`. Nalagalnik prebere mapo na **vsakem** klicu (sinhrono branje štirih majhnih datotek je cenejše od vsake strategije razveljavitve predpomnilnika), zato urejena datoteka stopi v veljavo s prvim naslednjim klicem — brez ponovnega zagona.
- Na dnu so stari literali v `rubriqueDefaults()` (`src/auto/skills.js`): vreme 15 min, novice 30 min, šport 30 min, obzorje 6 ur (in naslovi ARSO/RTV). Izbrisana ali okvarjena mapa `skills/` torej pomeni bajtno identično današnje vedenje — pogodba o privzetkih, ki jo test pinnira kot izvršljivo trditev.

## Kateri rubriki imajo `feed`

| Rubrika (ključ) | Skill | `feed` priključen? | Zakaj |
|---|---|---|---|
| novice (`news`) | `rtv-novice` | **da** | Bralec je splošen RSS odjemalec (naslovi `<item>`), zato sme URL zamenjati kateri koli RSS. |
| šport (`sport`) | `rtv-sport` | **da** | Enako — splošen RSS. |
| vreme (`weather`) | `arso-vreme` | **ne** (le dokumentiran) | ARSO bralec ni splošen: iz naslovov prispevkov izlušči opazovanja postaj (»POSTAJA: Opis, 18 °C.«). Drug RSS bi dal samo offline vrstico, zato ključ `feed` v datoteki nosimo kot dokumentacijo vira, v kodo pa ga NE priključimo. |
| obzorje (`onthisday`, `onthisdaymusic`) | `wikidata-dan` | **ne** (ključa sploh ni) | SPARQL končna točka ni RSS vir, ampak poizvedba, ki jo sestavi koda. Skill je cooldown-only. |

URL vira pride tudi v predpomnilniški ključ novice/šport, zato zamenjava vira stopi v veljavo takoj na naslednjem klicu, ne šele po izteku starega TTL-ja.

## Poštena degradacija

Skill ne more poslabšati oddaje:

- mrtev vir, timeout, HTTP napaka, ne-RSS ali prazen feed → funkcija vrne `null` → rubrika prebere **pošteno offline vrstico** (P4 #29/#30: nič izmišljenih naslovnic, nič izmišljenih stopinj);
- okvarjen, nepopoln ali izbrisan skill → kodni fallback (dobesedno današnji literali);
- glasba pri vsem tem **nikoli ne obstane** — skip-not-fail, kot vedno.

Test v `test/skills.test.mjs` prav to pinnira: feed, ki ni RSS, se pošteno razgradi v `null` (in nadalje v offline vrstico v `collectRubricData`).

## Odmik od SUB/WAVE: zaupanja vrat NI

SUB/WAVE sprejema skillse od kjerkoli (ZIP uvoz, obnova iz varnostne kopije, skupnostni katalog), zato koda, ki je prispela od drugod, pristane kot `tool.mjs.pending` in operater jo izda šele po pregledu sha256 prstnega odtisa (`POST /dj/skills/:slug/tool/trust`). radioclyde **nosi skillse v repozitoriju** — so del kode, ki ji že zaupate; nezanesljivega vnosa ni, zato vrat (.pending/sha256) nismo implementirali. To je zaveden in dokumentiran odmik: če bi radioclyde kdaj dobil uvoz skillov od drugod (npr. skupnostni katalog rubrik), je SUB/WAVE-ov vzorec pripravljen za ukrasti.

Iz istega razloga nismo vzeli še dveh SUB/WAVE-ovih dodatkov: `tool.mjs` (radioclyde nima segmentnega direktorja, ki bi klical tujo kodo — rubrike so deterministične funkcije v `feeds.js`) in `cron`/`cronOnly` (kadensa predvajanja je urnik).

## Kako dodamo ali spremenimo rubriko

**Sprememba kadence ali vira obstoječe rubrike:** uredi `skills/<slug>/SKILL.md` in shrani. Naslednji klic (prewarm ali produkcija oddaje) pobere novo vrednost — ponovni zagon ni potreben.

**Nova rubrika:** zaenkrat to **še vedno zahteva kodo** — fetcher v `src/auto/feeds.js`, ključ v `collectRubricData()`, predloge v `src/auto/templates.js`, segment v `scriptBuilder.js`. SKILL.md plast je zunanja nastavitev obstoječih rubrik, ne vtični sistem; ko je rubrika v kodi, lahko dobi mapo v `skills/` in s tem operatersko nastavljivost. To smo povedali pošteno v dokumentaciji, ker je bolje reči prej kot slej.

## Verifikacija

- `node --check src/auto/skills.js src/auto/feeds.js`
- `node --test --test-concurrency=1 test/skills.test.mjs` — 38 preizkusov: slovnica frontmatter, tabela cooldownov, SLUG_RE, nalagalnik (vključno z živimi uredbami brez predpomnilnika), pogodba o bajtno identičnih privzetkih proti realni mapi `skills/`, fallbacki in end-to-end ožičenje s stubanim fetchem (nič omrežja).
- Sosednji testi, ki prekrivajo `feeds.js`: `honestOffline`, `weatherOffline`, `onThisDay`, `quiz`, `listeners`, `doctor`.

## Reverzibilnost

Plast je popolnoma reverzibilna: izbriši mapo `skills/` in vsak klic pade na stare literale; povrni stare defaulte v `feeds.js` (po ena vrstica na funkcijo) in spet je vse hardcoded. Nobena nova odvisnost, nobena sprememba konfiguracije, nobena sprememba podpisov funkcij.
