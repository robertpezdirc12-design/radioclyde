# Zunanji scrobbling (Last.fm + ListenBrainz)

*Funkcija: pošteno poročanje o predvajani glasbi zunaj postaje. Preneseno iz SUB/WAVE-jevega stacka (`controller/src/broadcast/{scrobble,scrobble-pure}.ts`), ki ga je raziskovalni prehod preveril kot čisti HTTP/JSON — nikakršne umetne inteligence v poti. Radioclyde tu nima svojega profila poslušalca, zato je edini pošteni model "radio kot ena oseba": kar je resnično šlo po etru, gre v Last.fm in/ali ListenBrainz profil operaterja postaje, pod enakimi pogoji, pod katerimi bi to storil vsak glasbeni predvajalnik.*

## 1. Kaj je scrobbling

Scrobbling je poročanje o poslušani glasbi zunanjemu profilu (Last.fm ali ListenBrainz): vsaka predvajana skladba postane vpis v zgodovino profila, iz katere potem oba servisa računata statistiko, priporočila in letne povzetke. Za radioclyde to pomeni: skladba, ki je resnično stekla po etru, se v profilu pojavi takrat, ko bi se po pravilih Last.fm štela za "predvajano" — ne prej.

## 2. Moduli

| Datoteka | Vloga |
|---|---|
| `src/broadcast/scrobble.js` | Celotna implementacija: čista pravila (ugodnost, podpis, normalizacija URL-jev), odjemalca za Last.fm in ListenBrainz, mobilna seja s predpomnilnikom, orkestrator `submitScrobbles`. Vse pove (fetch, ura, datoteka seje, logger) je injektirano; modul nikoli ne vrže izjeme. |
| `src/plex/scrobbleTrack.js` | Sprožilec: ob zagonu vsakega segmenta prebere odhajajočo skladbo in — od vala 35 skozi izvlečeni `submitSegmentScrobbles` v obeh vejah, glasbeni in govorni — pokliče `submitScrobbles`. |
| `docs/scrobbling.md` | Ta dokument. |

Ni novih odvisnosti: `node:crypto` (md5 za `api_sig`), `node:fs` (predpomnilnik seje) in vgrajeni `fetch`.

## 3. Konfiguracija

Privzeto IZKLOPLJENO — obstoječe namestitve se ob nadgradnji ne spremenijo niti za bajt (pravilo poštenega propada):

```json
"scrobble": {
  "lastfm": {
    "enabled": false,
    "apiKey": "CHANGE_ME",
    "apiSecret": "CHANGE_ME",
    "sessionKey": "",
    "username": "",
    "password": ""
  },
  "listenbrainz": {
    "enabled": false,
    "userToken": "",
    "baseUrl": ""
  }
}
```

Vsaka storitev je neodvisna: vklopi jo `enabled: true` plus njene lastne prijave. `baseUrl` pri ListenBrainz je neobvezen (privzeto `https://api.listenbrainz.org/1`); sprejme koren API-ja ali cel končni naslov `/submit-listens`, z ali brez končnega poševnika — normalizira se v enega samega URL-ja.

## 4. Kdaj se kaj pošlje

Model je SUB/WAVE-jev, prenesen na radioclydejev "en proces na segment": ob **prehodu med segmentoma** se zgodita dve stvari hkrati:

- **now-playing za PRIHAJAJOČO skladbo** (`track.updateNowPlaying` / `listen_type: "playing_now"`) — takoj, ko skladba začne igrati;
- **scrobble za ODHAJAJOČO skladbo** (`track.scrobble` / `listen_type: "single"`), in sicer z **časovnim žigom njenega začetka** (`playedAt` iz `now_playing_track.json`).

Zakaj se oddajo šele ob prehodu? Ker je Last.fm-ov časovni žig definiran kot **trenutek, ko se je skladba začela predvajati** — ne, ko se je končala. Proces `scrobbleTrack.js` se sproži na začetku vsakega segmenta, torej je "konec prejšnje skladbe" videti natanko kot "začetek naslednje": oddaja ob prehodu ni zamuda, temveč točno pravi trenutek, in žig ostane začetek, kot zahteva specifikacija. Prav tako se šele tu ve, kako dolgo je bila odhajajoča skladba resnično na etru — pogoj spodaj.

**Govorni segment je tudi prehod (val 35).** Ko DJ začne govoriti, skladba, ki je prav takrat končala, postane odhajajoča stran TEGA prehoda — in se odda takoj, na začetku govora (z istim žigom `playedAt`, pod isto vrato poslušalcev in istim pravilom ugodnosti). Prihajajoča stran govora NI skladba, zato se za govor nikamor ne pošlje now-playing. Do vala 35 je govorna veja procesa vračala pred zunanjo-plastjo blokom, `{dj:...}` stanje pa je naslednji glasbeni segment pustilo brez odhajajoče strani — vsaka skladba pred govorom je bila tiho zamujena (spodaj v razdelku 9 je ta omejitev zdaj zgodovina). Dva zaporedna govorna segmenta ne dvakrat prispevata: prvi odda skladbo, drugi že vidi `{dj:...}` stanje, ki odhajajoče strani ni.

### Ugodnost (Last.fm-ovo pravilo)

Skladba se poscrobbla **samo**, če je hkrati:

| Pogoj | Pravilo |
|---|---|
| Trajanje | več kot 30 s (`MIN_DURATION_SEC`; skladba, dolga 30 s ali manj, nikoli ne šteje) |
| Poslušano | vsaj **polovica** trajanja **ali** vsaj **240 s** (`MIN_ELAPSED_FLOOR_SEC`) — karkoli se zgodi prej |
| Neznana duracija | namesto nje velja samo prag 30 s dejansko predvajanja |
| Metapodatki | skladba mora imeti izvajalca in naslov (govor DJ-ja in džingli niso predvajanja) |

Od vala 35 odhajajoča stran **res nosi svojo duracijo**: `readOutgoingTrack` pretvori `durationMs` zapisa v `durationSec` (ista pretvorba, ki jo prihajajoča stran uporablja od začetka), zato se pravilo pol-trajanja dejansko sproži — skladba, ki jo je prehod prerezal na manj kot polovično poslušanost, se pravilno zadrži, popolnoma poslušana pa se odda z bogatejšimi metapodatki (trajanje gre sedaj tudi v Last.fm in ListenBrainz vpis). "Neznana duracija" ostane samo za zapise brez trajanja.

### Vrata poslušalcev (fail-closed)

Brez poslušalcev ni predvajanja: pri **0** poslušalcih se ne pošlje nič. Pri **neznanem** številu (Icecast odgovarja z napako, štetje ni na voljo) se prav tako ne pošlje nič — vrata so **zaprta po dogovoru** (fail-closed): raje, da v profilu manjka vpis, kot da ga med prekinitvijo merjenja onesnažujemo. To je enaka logika, ki jo že uporablja Plexova vrata v istem procesu (`listenerCount > 0`), z isto vrednostjo, enkrat na segment.

## 5. Last.fm

**Ključa.** Na [last.fm/api](https://www.last.fm/api) ustvari "API account" (povezava *Create an API account* na dnu strani): izpolni poljubno ime aplikacije in kontaktni e-poštni naslov; dobiš `API key` in `shared secret`. Oba vpiši v `scrobble.lastfm.apiKey` / `apiSecret`.

**Mobilna seja — enkraten vnos gesla.** Namesto SUB/WAVE-jevega brskalniškega OAuth poteka (ki zahteva administrativni vmesnik, radioclyde pa je brezglavi) implementacija uporablja `auth.getMobileSession`: vpiši `username` in `password` svojega Last.fm računa v konfiguracijo. Ob prvem scrobblu modul:

1. pokliče `auth.getMobileSession` (enak podpis `api_sig` kot vsi ostali klici),
2. dobljeni `sessionKey` zapiše v `dataDir/lastfm-session.json` — **atomarno** (tmp-`<pid>` + preimenovanje, vzorec `pollsStore.js`) in z dovoljenjem **0600** (datoteka je živa prijava za Last.fm račun, enak vzorec kot `push/vapid.json`),
3. od tedaj naprej vsak zagon raje prebere predpomnilnik kot da bi koval novo sejo.

Ko datoteka obstaja, **geslo lahko pobrišeš iz config.json** (in svetujemo, da ga) — sejo bo modul uporabljal iz predpomnilnika. Če želiš sejo zamenjati (npr. menjal si račun), pobriši `dataDir/lastfm-session.json` in na kratko spet vpiši uporabniško ime + geslo. Ročno prilepljen `sessionKey` v konfiguraciji vedno zmaga nad obema (niti predpomnilnik niti kovanje se ne dotakneta).

## 6. ListenBrainz

[listenbrainz.org](https://listenbrainz.org) je odprta alternativa Last.fm-u. Uporabniški žeton dobiš pod *Settings → MusicBrainz User Token* (poročila o poslušanju) in ga vpiši v `scrobble.listenbrainz.userToken`. Za lastni strežnik (npr. lokalna namestitev LB) nastavi `baseUrl`. Geslo ni treba: žeton je vse, kar API potrebuje, in enkraten vpis ne obstaja.

## 7. Zasebnost

K last.fm-u in/ali ListenBrainz gredo **samo** metapodatki predvajane glasbe: izvajalca, naslov, album (če obstaja), trajanje in časovni žig začetka. Nikoli ne grejo: naslovi IP poslušalcev, števila poslušalcev (to je samo notranja vrata), identitete poslušalcev, besedila ali karkoli o postaji same. Če je težava, da te podatke vidi tretja oseba — izklopi z `enabled: false` ali pobriši blok; podatkov, ki so že odšli, seveda ne moremo umakniti (kot pri vsakem realnem scrobblingu).

## 8. Reverzibilnost

Pobriši `scrobble` blok iz config.json (ali pusti `enabled: false`): vsa koda pod njim postane no-op, datoteke, ki jih je modul naredil, so samo `dataDir/lastfm-session.json` (pobriši ročno, če želiš) in dnevniške vrstice. Ni sheme, ni migracije, ni zaostanka.

## 9. Poštene omejitve

- **Ni vrste za ponovne poskuse.** Vsak klic ima 5-sekundno prekinitev in ob napaki propade z vrstico v dnevniku — kot pri SUB/WAVE: fire-and-forget. Spodleteli klic je izgubljen; naslednja skladba pa bo poskusila znova, ker je vsak prehod neodvisen.
- **Zadnja skladba pred ustavitvijo se ne poscrobbla**, ker ni prišlo do prehoda — proces, ki bi jo oddal, se sproži šele ob začetku naslednjega segmenta.
- **Posodobitve now-playing gredo ob zagonu skladbe** — ne ob preskoku ali premoru; dokler skladba teče, zunanji profil o njej ve samo, da "zdaj predvaja".
- **Skladba pred DJ-jevim govorom se poscrobbla (od vala 35).** Zgodovina: do vala 35 se je v tem primeru zgodilo ravno nasprotno — govorna veja je vračala pred blokom, `{dj:...}` prepis stanja pa je naslednji skladbi pustil brez odhajajoče strani, torej zamujen vpis (dokumentirana, zavestna posledica poenostavitve "eno stanje, ena datoteka"). Val 35 je govorni segment naredil za polnopravni prehod: skladba se odda na začetku govora, z žigom svojega začetka, pod enakimi pogoji kot vsak drug prehod.
- Filler skladbe se scrobbajo kot vse ostale: če so šle po etru, so bile predvajane — enako pravilo že velja za TuneIn in Plex.
