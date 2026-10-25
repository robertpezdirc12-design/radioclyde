---
name: ARSO vreme
cooldown: 15m
feed: https://meteo.arso.gov.si/uploads/probase/www/observ/surface/text/sl/observation_si_latest.rss
---
Rubrika *vreme*: avtomatski način prebere zadnja uradna opazovanja slovenskih postaj iz ARSO-jevega RSS in iz naslovov prispevkov izlušči opazovanje za nastavljeno postajo (privzeto Ljubljana) — stanje neba in temperaturo, brez izmišljanja.
Vir se osvežuje približno na 30 minut, zato je privzeti cooldown 15 minut; kadenco spremenite TUKAJ, brez dotikanja kode.
Opozorilo: `feed` je v tej datoteki le dokumentiran, NI pa priključen — bralec v `src/auto/feeds.js` razume izključno ARSO-jev RSS (naslovi v obliki »POSTAJA: Opis, 18 °C.«), zato zamenjava vira ne bi dala vremena.
Ko je vir mrtev (timeout, HTTP napaka, prazen feed, postaja brez ujemanja), rubrika ne utihne: prebere se poštena offline vrstica, glasba nikoli ne obstane.
