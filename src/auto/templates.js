// Template-based DJ speech -- the station's only speech source (since
// Val 28 the former LLM completions in producer/moves.js and
// director/liveSegments.js are removed outright). Each broadcast moment
// (open, track intro, post-track recap, quiz, weather handoff, close, live
// time/weather) is one of a small set of fixed sentence templates with
// {placeholders}, drawn from the show's real library metadata. Default
// templates are Slovenian; every slot can be
// overridden or extended via config.autoRadio.templates (see
// docs/auto-radio.md for the full reference).
//
// Variant selection is a hash of (showId|date|ratingKey|slot), so:
//   - the same occurrence always renders the same line (reproducible
//     transcripts, cacheable audio), and
//   - different days/tracks rotate through the variants without a model.
//
// Val 27 "sproscen register": the default pools speak the relaxed rock
// register the Markec Podkast persona (P5 #1) already proved on air --
// short conversational sentences, a light sprinkle of discourse fillers
// (max ONE per variant, DISCOURSE_MARKERS below; the register lint in
// test/voiceRegister.test.mjs enforces both), dry humor over formality,
// no parentheses ever (they read as stage directions, not speech). Pools
// are kept fat (4-6 variants where the contracts allow) because a thin
// pool plus hash selection is exactly how a synthetic station ends up
// repeating itself -- the tell listeners use to clock a fake host.
// Factual rubrics keep their honesty contracts unchanged (weatherOffline/
// newsOffline/sportOffline/obzorjeOffline/obzorje/obzorjeGlasba pools are
// untouched). Units are spelled out for TTS ("stopinj", "kilometrov na
// uro") -- abbreviations like "km/h" get read letter by letter.
import { config } from '../config/index.js';
import { currentLocalTimeString, currentLocalDateString } from '../director/weather.js';

// ---------------------------------------------------------------------------
// defaults (Slovenian)
// ---------------------------------------------------------------------------

// Exported for tests that validate pool integrity (TTS-friendliness lints,
// variant counts) against the DEFAULTS -- the config override path is
// intentionally not visible here: these are the station's built-in pools.
export const DEFAULT_TEMPLATES = {
  open: {
    default: [
      'Poslu\u0161ate {station}. Tako -- zdaj pa oddaja {show}.',
      'Dobrodo\u0161li na {station}. Na vrsti je {show}.',
      'Poslu\u0161ate {station}. Prihaja oddaja {show}.',
      'Dobrodo\u0161li pri oddaji {show}, tukaj na {station}. Kar se namestite.',
    ],
    morning: [
      'Dobro jutro! Poslu\u0161ate {station}. Prihaja oddaja {show}.',
      'Dobro jutro! {station} je pri\u017eana, {show} pa starta zdaj.',
      'Dobro jutro, dobro jutro -- {show} na {station} je tu.',
    ],
    daytime: [
      'Poslu\u0161ate {station} -- zdaj sledi oddaja {show}.',
      'Dan je v polnem teku, {station} pa vrti {show}.',
      'Tukaj {station}: na sporedu {show}, kar ostanite pri nas.',
    ],
    evening: [
      'Dober ve\u010der! Na sporedu je oddaja {show} na {station}.',
      'Dober ve\u010der! {station} in {show} -- za\u010dnimo.',
      'Dober ve\u010der, ve\u010der je na\u0161: {show} tu na {station}.',
    ],
    night: [
      'Pozno v no\u010d -- poslu\u0161ate {station}. Prihaja {show}.',
      'Pozno v no\u010d, a ne sami: {station} je \u0161e budna, {show} pa tu.',
      'Pozno v no\u010d je, glasba pa ni \u0161la spat: {show} na {station}.',
    ],
  },
  intro: [
    'Zdaj sledi {artist} s skladbo {title}.',
    'Naprej poslu\u0161amo {artist} -- {title}.',
    'No, na vrsti je {artist} s skladbo {title}.',
    '{title} od {artist} -- takoj za tem.',
    'Sledi {artist}, naslov pa {title}.',
    'Tako -- {artist}, {title}. Kar dajte glasneje.',
  ],
  recap: {
    withAlbumYear: [
      'To je bil {artist} s skladbo {title} iz albuma {album}, iz\u0161etega leta {year}.',
      '{artist} -- {title}. Najdemo ga na albumu {album} iz leta {year}.',
      'To je bil {artist}: {title}, album {album}, leto {year}.',
    ],
    withYear: [
      'Poslu\u0161ali ste {title} izvajalca {artist}, iz\u0161eto leta {year}.',
      'To je bil {artist} -- {title}, iz leta {year}.',
      'Pravkar {title} od {artist} -- leto nastanka {year}.',
    ],
    generic: [
      'To je bila skladba {title} izvajalca {artist}.',
      '{artist} z naslovom {title}, tukaj na {station}.',
      'Pravkar {artist} -- {title}. Tako.',
    ],
  },
  quizIntro: [
    'Uganite, v katerem letu je iz\u0161la naslednja skladba izvajalca {artist}. Odgovor razkrijemo takoj po njej.',
    'Kviz \u010das: skladba, ki sledi, je iz\u0161la v enem od let v tem desetletju -- uganite, kdaj. Odgovor sledi.',
  ],
  quizReveal: [
    'Pravilen odgovor: {title} je iz\u0161la leta {year}. \u010ce ste zadeli, \u010destitamo!',
    'Re\u0161itev kviza -- {year}. {artist} s skladbo {title}.',
  ],
  // P4 #22 "Kviz" rubric: real question/answer content from auto/quizFacts.js
  // renders through these keys; the legacy year-guess quizIntro/quizReveal
  // above stay as the fallback when the rubric is off or the corpus is empty.
  // P4 #24 tone pass: the pools mix plain and playful variants -- every
  // question variant promises the answer right after the song, every answer
  // variant names it ("Pravilen odgovor" / "Re\u0161itev kviza") -- see
  // test/quiz.test.mjs section E, which pins exactly that contract.
  quizQuestion: [
    'Kviz za pozorne poslu\u0161alce: {question} Odgovor razkrijemo takoj po skladbi.',
    'Malo tekmovalnosti -- {question} Pravilni odgovor povemo takoj po skladbi.',
    'Malica za mo\u017egane, vstop brezpla\u010den: {question} Re\u0161itev razkrijemo takoj po skladbi.',
    'Doma\u010da naloga za vse, ki trdijo, da o rocku vedo vse: {question} Odgovor povemo takoj po skladbi.',
    'Kdor ugane, dobi rundo aplavza: {question} Odgovor razkrijemo takoj po skladbi.',
    'Ugibanje je brez vstopnic, mikrofon pa vse sli\u0161i: {question} Odgovor povemo takoj po skladbi.',
    'No, kaj pravite: {question} Odgovor razkrijemo takoj po skladbi.',
  ],
  quizAnswer: [
    'Pravilen odgovor: {answer}. \u010ce ste zadeli, \u010destitamo!',
    'Re\u0161itev kviza: {answer}. Zdaj pa nazaj k glasbi.',
    'Pravilen odgovor je {answer} -- in vsem, ki ste ugibali kaj drugega, priznavamo vsaj vztrajnost.',
    'Re\u0161itev kviza: {answer}. Kdor je zadel, mu dol\u017eim eno pivo -- izpla\u010dilo ob naslednjem sre\u010danju.',
    'Pravilen odgovor: {answer}. Tega znanja nikjer ne kupite, tukaj pa ste ga dobili zastonj.',
    'Re\u0161itev kviza: {answer}. Kdor ni zadel, zdaj ve ve\u010d kot pred minuto.',
  ],
  handoff: [
    'Poglejmo \u0161e, kak\u0161no vreme nas \u010daka. \u010cez mikrofon se oglasi {to}.',
    'Vremenska napoved sledi -- prijavlja {to}.',
    'Vreme prevzame {to}, jaz pa grem po kavico.',
  ],
  close: {
    default: [
      'To je bilo vse za tokrat. Hvala, ker poslu\u0161ate {station}.',
      'S tem je oddaja {show} zaklju\u010dena. Do naslednjega sre\u010danja!',
      'In to je to -- hvala, da ste bili z nami. {station} ostaja pri\u017eana.',
    ],
    morning: [
      'Lep za\u010detek dneva \u017eelim -- hvala, da poslu\u0161ate {station}.',
      'Dan naj se nadaljuje v rocku -- {station} ostaja z vami.',
    ],
    daytime: [
      'Prijetno nadaljevanje dneva -- tukaj je {station}.',
      'Dan se \u0161e ni kon\u010dal, {station} pa tudi ne.',
    ],
    evening: [
      'Dober ve\u010der \u017eelim in hvala, ker ste bili z nami na {station}.',
      'Dober ve\u010der \u0161e naprej -- {station} pa vrti naprej.',
    ],
    night: [
      'Lahko no\u010d in hvala, da ste bili ob nas na {station}.',
      'Lahko no\u010d -- glasba na {station} ostane budna \u0161e malo.',
    ],
  },
  live: {
    // Val 27: units are SPELLED OUT ("stopinj", "kilometrov na uro") --
    // "\u00b0C" and "km/h" are read letter-by-letter by the TTS engines,
    // which is the single most robotic sound a weather line can make. The
    // opener "Trenutno je" is a pinned contract (weatherOffline.test.mjs
    // B-block) -- every time variant keeps it.
    time: [
      'Trenutno je {time}.',
      'Trenutno je {time} -- ura te\u010de, rock tudi.',
      'Trenutno je {time}, in to je edini urnik, ki ga potrebujete.',
    ],
    weather: [
      'Zunaj je {condition}, temperatura {temp} stopinj, veter pa {wind} kilometrov na uro.',
      'Vreme takole: {condition}, {temp} stopinj, veter {wind} kilometrov na uro.',
    ],
    'time-weather': [
      'Je {time}, zunaj je {condition} in {temp} stopinj.',
      'Ura je {time}, zunaj pa {condition}, {temp} stopinj.',
    ],
    // P4 #29: the live weather segment resolved at DIRECT time -- and
    // directShow() awaits resolveLiveLine() with no retry, so a dead
    // Open-Meteo used to throw and kill the whole occurrence (no
    // playlist.m3u -> dead air until the next scheduled show). Now it
    // resolves to this pool: honest (the time is the local clock, the only
    // fact left), no fabricated condition/temperature, same honesty rules
    // as weatherOffline above. Every variant opens with "Je {time}" so the
    // rendered line stays visibly a live segment.
    weatherOffline: [
      'Je {time}, podatkov o vremenu pa ni -- zato samo toliko: zunaj se danes odvija vreme, za podrobnosti pa priporočam okno.',
      'Je {time} -- vremenska povezava je na dopustu, okna pa delujejo brez omejitev. Vabim k lastnemu poročanju.',
      'Je {time}. Vremenskih podatkov ni, ugib pa je takšen: zunaj je vsaj nekaj. Podrobneje vas obvestijo lastna očesa.',
      'Je {time} in vremenske napovedi ni -- uradno torej: danes bo vreme. Natančnost si delite z oknom, ki je pri vas.',
    ],
    // Paket B1 (docs/programming-research.md §5): the closing "what's next"
    // announcement. Resolved at DIRECT time (auto/liveLines.js, from
    // scheduleUtil.nextOccurrence) -- never at script time, because same-day
    // repeats share one script.md AND one dj-audio cache, so a script-time
    // "next show" would name a show that already aired on the re-run. Split by
    // host presence (weatherNow's temp/condition pattern): a hostless show must
    // never render a dangling "z voditeljem" clause. {nextDayWord} is the
    // Slovenian relative label ('danes' / 'jutri' / 'v ponedeljek') resolved by
    // lib/time.js's slovenianDayLabel against the current show's NOMINAL end.
    nextShow: {
      withHost: [
        'Takoj za mano pa {nextDayWord} ob {nextTime} -- oddaja {nextShow} z voditeljem {nextHost}. Ostani z nami!',
        'Kaj sledi po tej oddaji? {nextDayWord} ob {nextTime} vas čaka {nextShow} z voditeljem {nextHost}. Ne odhajajte predaleč.',
        '{nextDayWord} ob {nextTime} prisluhnite {nextShow} -- za mikrofonom bo {nextHost}. Do takrat pa kar ostajte pri nas!',
        'Glejte, {nextDayWord} ob {nextTime} pride {nextShow}, za mikrofonom pa {nextHost}. Kar ostanite!',
      ],
      noHost: [
        'Takoj za mano pa {nextDayWord} ob {nextTime} -- oddaja {nextShow}. Ostani z nami!',
        'Kaj sledi po tej oddaji? {nextDayWord} ob {nextTime} vas čaka {nextShow}. Ne odhajajte predaleč.',
        '{nextDayWord} ob {nextTime} prisluhnite {nextShow}. Do takrat pa kar ostajte pri nas!',
        'Za tem \u0161e {nextDayWord} ob {nextTime} pride {nextShow}. Mikrofon pa ne gre nikamor.',
      ],
    },
    // Honest degradation (P4 #29 pattern, weatherOffline's sibling): no next
    // show found / schedule unreadable / occurrence unresolvable -> a line that
    // invents NOTHING (no day, no time, no show name) and hands the mic back.
    nextShowOffline: [
      'Kaj sledi po tej oddaji, za zdaj še ne vemo -- urnik trenutno molči, glasba pa gotovo ne.',
      'Naslednja oddaja za zdaj ni v pregledu -- ko urnik spet spregovori, vam povemo. Do takrat kar ostanite z nami.',
      'Podatka o naslednji oddaji trenutno ni -- mikrofon oddahne, glasba pa prevzame. Poslušajte naprej.',
      'Za tisto, kaj sledi, urnik danes še ni povedal ničesar zanesljivega -- zato kar počakajte na glasbo.',
    ],
  },

  // Rubrikes (service segments rendered from real data at produce time --
  // see auto/feeds.js). weatherNow/sportHeadlines/obzorje read the ARSO
  // observation, RTV Slovenija headlines and Wikidata "on this day"
  // respectively; every pool degrades to a shorter variant when data is
  // partial (e.g. ARSO reports a temperature but no condition).
  weatherNow: {
    withTemp: [
      'Vreme: {station} -- {condition}, {temp} stopinj Celzija.',
      'Tako je zunaj: {station}, {condition}, {temp} stopinj.',
      'Trenutne razmere: {station}, {condition}, temperatura {temp} stopinj.',
    ],
    tempOnly: [
      'Vreme: {station}, trenutno {temp} stopinj Celzija.',
      'Tako je zunaj: {station} -- {temp} stopinj.',
    ],
    generic: [
      'Vreme: {station} -- {condition}.',
      'Trenutne razmere na {station}: {condition}.',
    ],
  },
  // P4 #29 "vreme brez omrežja": when ARSO is unreachable (dead router,
  // timeout, station missing) the rubric no longer vanishes -- it airs an
  // HONEST offline line instead. Ground rules, enforced by
  // test/weatherOffline.test.mjs:
  //   - zero fabricated data: no digits, no degrees, no "stopinj", and no
  //     word the WMO map could produce as a "condition" -- a weather report
  //     without numbers cannot pretend to be data,
  //   - every variant names the station (colon construction, no declension
  //     of the ARSO station name), so the line keeps the rubric's shape,
  //   - the joke is the honesty: the line says out loud that there are no
  //     data and points to the only reliable sensor the listener owns.
  weatherOffline: [
    'Vreme: postaja {station} se je danes poslala na dopust -- uradnih podatkov ni, priporočamo pa brezplačno aplikacijo, ki ji rečemo okno.',
    'Vremensko poročilo z danes: {station} javlja tišino -- podatkov ni. Vse ostalo si poglejte skozi okno, aplikacija je brezplačna in brez reklam.',
    'Vreme: {station} trenutno molči, mi pa ne -- danes bo vreme, napoved zanesljiva kot vsako leto v tem času.',
    'Vremenski podatki iz {station} so odsotni, zato napovedujemo edino, kar vemo zanesljivo: zunaj je vsaj nekaj.',
    'Vreme: brez podatkov iz {station} -- meteorologi so v zastoju, okna pa delujejo normalno. Vabimo k lastnemu raziskovanju.',
  ],
  sportHeadlines: [
    '\u0160portne novice: {headlines}',
    'Poglejmo, kaj je novega v \u0161portu: {headlines}',
    'Iz sveta \u0161porta: {headlines}',
  ],
  newsHeadlines: [
    'Novice: {headlines}',
    'Iz Slovenije in sveta: {headlines}',
    'Kaj se dogaja: {headlines}',
  ],
  // P4 #30 "po\u0161tene offline vrstice" for the three remaining network
  // rubrics: novice (RTV news RSS), \u0161port (RTV sport RSS) and obzorje
  // (Wikidata on-this-day). When the source is dead or empty the rubric no
  // longer vanishes -- it airs an HONEST line instead, under STRICTER
  // honesty rules than the weather offline pool (enforced by
  // test/honestOffline.test.mjs):
  //   - zero fabricated content: no digits (a headline service without
  //     numbers cannot pretend to have headlines), no named people, teams,
  //     dates or results, and no source blame on air (no "RTV"/"Wikidata" --
  //     the pools stay source-generic),
  //   - every variant keeps the rubric's shape marker, mirroring the data
  //     templates above: newsOffline opens "Novice:", sportOffline
  //     "\u0160portne novice:", obzorjeOffline "Na dana\u0161nji dan",
  //   - the joke is the honesty: the line says out loud that today there
  //     are no headlines and hands the microphone to the music.
  newsOffline: [
    'Novice: novi\u010darski vir se je danes odpravil na po\u010ditnice -- novic ni, glasba pa poro\u010da namesto njih.',
    'Novice: vir trenutno mol\u010di, mi pa ne -- dana\u0161nja posebna novica je, da jih ni. Namesto naslovov torej le pesmi, ki naslove imajo.',
    'Novice: povezava z novi\u010darskim virom je na dopustu -- svet se je nekako kar vrtel naprej, mi pa po\u010dakamo, da nam ga jutri povedo.',
    'Novice: danes brez sve\u017eih naslovov -- vir mol\u010di, glasba pa zanesljivo ne. Poslu\u0161ajte torej edino rubriko, ki nikoli ne gre na dopust.',
    'Novice: ni jih -- vir novic je danes za vodo, mikrofon pa zato v slu\u017ebi glasbe. Naslovi pridejo jutri, pesmi pa takoj.',
  ],
  sportOffline: [
    '\u0160portne novice: vir rezultatov je danes na ogrevanju -- uradnih izidov ni, glasba pa ima svoj tempo tudi brez \u0161toparice.',
    '\u0160portne novice: povezava je padla v prvem pol\u010dasu -- izidi ostajajo uradno neznani, muzika pa igra naprej, brez podalj\u0161kov.',
    '\u0160portne novice: danes brez rezultatov -- \u0161portni vir se je poslal na dopust, tekmovanje, kdo bolj u\u017eiva v glasbi, pa se nadaljuje pri vas.',
    '\u0160portne novice: vir trenutno mol\u010di -- edini zanesljiv rezultat dana\u0161njega dne je, da glasba vodi z ena ni\u010d.',
    '\u0160portne novice: ni jih -- \u0161portni vir je danes za vodo, mesta naslovnic pa je zasedla glasba. Izidi se vra\u010dajo jutri.',
  ],
  obzorjeOffline: [
    'Na dana\u0161nji dan: arhiv zgodovine je danes zaklenjen -- rojstnih danov in obletnic torej ne razgla\u0161amo. Glasba pa se poslu\u0161a kot ob vsakem drugem dnevu.',
    'Na dana\u0161nji dan: arhiv nam ni zaupal, kdo se je rodil in kdo se je poslovil. Tola\u017eimo se z glasbo, ki svojega letnika ne skriva.',
    'Na dana\u0161nji dan: zgodovinski arhiv trenutno mol\u010di -- ime in leto ostajata uradno nepovedana, glasba pa govori sama zase.',
    'Na dana\u0161nji dan: arhiv je danes za vodo -- kdo se je vse rodil, ostaja uradno neznan, pesem pa kljub temu navdu\u0161eno zapojemo.',
  ],
  obzorje: {
    birth: [
      'Na današnji dan leta {year} se je rodil {name}.',
      'Na ta dan, {year}, se je rodil {name} -- datum je očitno izbral namenoma, ker so mu tako vsako leto skuhali torto.',
    ],
    birthF: [
      'Na današnji dan leta {year} se je rodila {name}.',
      'Na ta dan, {year}, se je rodila {name} -- svet se tisti dan ni karaval, je pa se dolgoročno spremenil na bolje.',
    ],
    death: [
      'Na današnji dan leta {year} je umrl {name}.',
      'Na ta dan leta {year} se je {name} poslovil -- zgodovina si je zapisa, mi pa zapomnili, po možnosti še na plošči.',
    ],
    deathF: [
      'Na današnji dan leta {year} je umrla {name}.',
      'Na ta dan leta {year} se je {name} poslovila -- zgodovina si je zapisa, mi pa zapomnili, po možnosti še na plošči.',
    ],
  },

  // P4 #19: "Na dana\u0161nji dan v glasbi" -- same data shape as obzorje
  // (Wikidata births/deaths), but the people are musicians (P106/P279* ->
  // Q639669), so the sentences name the rubric. Same kindKey pools.
  obzorjeGlasba: {
    birth: [
      'Na današnji dan v glasbi se je leta {year} rodil {name}.',
      'Na ta dan v glasbi, {year}: rojil se je {name} -- svet še ni vedel, radioski spomin pa ga od takrat obeležuje vsako leto.',
    ],
    birthF: [
      'Na današnji dan v glasbi se je leta {year} rodila {name}.',
      'Na ta dan v glasbi, {year}: rojila se je {name} -- in enkrat za vselej dokazala, da mikrofon ni samo za moške basi.',
    ],
    death: [
      'Na današnji dan v glasbi je leta {year} umrl {name}.',
      'Na ta dan v glasbi, {year}, je {name} zapel zadnjič -- plošče pa od takrat molčijo le, ko jih mi izklopimo.',
    ],
    deathF: [
      'Na današnji dan v glasbi je leta {year} umrla {name}.',
      'Na ta dan v glasbi, {year}, je {name} zapela zadnjič -- njene pesmi pa od takrat pojejo namesto nje.',
    ],
  },

  // P4 #17: "Zanimivosti" -- one deterministic fact before the track whose
  // artist it describes (triviaArtist, from auto/trivia.js), or a general
  // rock-history fact (triviaGeneral, from the local auto/rockFacts.js
  // corpus). Facts arrive as FULL sentences WITHOUT the final punctuation;
  // the template supplies it, so all three fact sources stay consistent.
  triviaArtist: [
    '\u010ce niste vedeli: {fact}. Zdaj pa nazaj k glasbi.',
    'Malo zanimivosti: {fact}. In nadaljujemo z glasbo.',
    'Malo zgodovine, preden sledi skladba: {fact}.',
    'Tole pa nosite s seboj ves dan: {fact}.',
  ],
  triviaGeneral: [
    'Ste to vedeli? {fact}. Zdaj pa nadaljujemo z glasbi.',
    'Zanimivost iz sveta rocka: {fact}. In nazaj k glasbi.',
    'Medtem, ko gre glasba naprej -- {fact}.',
    'To pa ni vsak dan: {fact}.',
  ],

  // P4 #25: "Sledi kasneje" (tease) -- the professional radios' move of
  // teasing what the show holds later. Rendered once, right after the
  // rubrica block and before the first track; values carry the artist from
  // the back half of the already-built queue, so the tease is true by
  // construction (no promises about things the queue would not keep).
  tease: [
    'Kasneje v oddaji sli\u0161ite \u0161e {artist}. Ostajajte pri nas -- naprej pa samo glasba.',
    '\u0160e sledi {artist}, med tem pa kviz, vreme in lepo dogajanje. Ni\u010d ne presko\u010dite.',
    'No -- {artist} pride \u0161e v tej oddaji. Dr\u017eite se.',
  ],
  teaseQuiz: [
    'Kasneje tudi kviz z resni\u010dnim vpra\u0161anjem iz zgodovine rocka -- in sli\u0161ite \u0161e {artist}. Ne odhajajte pred\u010dasno.',
    'V drugi polovici kviz: ugibajte z nami. Kasneje pa \u0161e {artist}.',
    'Kviz \u0161e prihaja, {artist} tudi -- nikamor ne hitite.',
  ],
  // Val 28 C1: the MID-show tease -- one more touch of the professional
  // radio pattern (top tease + mid tease bookending the show's second half).
  // Renders once at the fenceposts module's midTeaseIndex (the quiz position
  // when a quiz exists, else halfway), naming an artist still ahead in the
  // queue -- true by construction, same rule as the top tease.
  teaseMid: [
    'Pred nami je \u0161e {artist} -- ostajajte pri nas.',
    'V drugi polovici poslu\u0161ate \u0161e {artist}.',
    '\u0160e {artist} pride v tej oddaji -- kar dr\u017eite se.',
    'Glejte, \u010dez kak\u0161no pesem pa \u0161e {artist}. Ne odhajajte.',
  ],

  // P4 #25: "Anketa" rubric -- the listener poll (server/pollsStore.js) read
  // at air time. Two shapes: fresh poll (no votes yet) asks for votes, a
  // running one reports the honest current tally, never a winner claim.
  pollRunning: [
    'Anketa te\u010de: {question}. Glasujte na strani postaje, rezultate pa razkrijemo \u0161e tokrat v oddaji.',
    'Odprta anketa: {question}. Va\u0161 glas \u0161teje -- povejte, kaj menite, na strani postaje.',
    'Va\u0161e mnenje nas zanima: {question}. Glasovanje je na strani postaje.',
  ],
  pollResults: [
    'Anketa: {question}. Do zdaj {total} glasov, vodi {leader} z {leaderVotes}. Glasovanje \u0161e traja.',
    'Medpostava iz ankete: {question}. Trenutno vodi {leader} z {leaderVotes} od {total} glasov. Hvala za glasove!',
    'Anketa \u017eivi: {question} -- {leader} vodi z {leaderVotes} od {total} glasov.',
  ],

  // P4 #26: "Poslusalci" rubric -- freshly approved listener requests and
  // dedications (server/requestsStore.js, status 'approved', windowed). The
  // studio approves, the air reads. Only the shout line carries metadata;
  // dedication messages arrive TRUNCATED by the collector, so templates
  // never have to cut a listener's words mid-thought.
  requestShout: [
    'Poslu\u0161alceva izbira: {artist} -- {title}. Dober vkus, povsem po mojem zanesenja\u010du.',
    'Po va\u0161ih zahtevah: {title} od {artist}. Svetovna izbira -- tudi mikrofon bi aplaudiral.',
    'Va\u0161 zahtevek gre na zrak: {artist} -- {title}. Tole je oddaja, ki jo pi\u0161ete vi.',
    'Zahtevanka! {artist} -- {title}. \u017delja poslu\u0161alca je zakon.',
  ],
  dedicationShout: [
    'Posvetilo: {message}. Iz mikrofona gre nazaj en sam velik pozdrav.',
    'Sli\u0161ite posvetilo: {message}. Lepo od vas -- hvala, da pi\u0161ete.',
    'Posvetilo je prispelo: {message}. Glasba, prosim!',
  ],

  // Markec Podkast (P5 #1): petminutna samostojna enota glasba-klepet-glasba.
  // Persona je ZAJEBANT -- rokovska ironija in kratki stavki, ne kričanje:
  // Piper TTS kričanje flattenira v umazan zvok, zato je vsa "agresija"
  // v izbesci, glas pa ostane čist (glej docs/auto-radio.md, razdelek o
  // personi). Pravila bazenov: brez oklepajev, brez okrajšav, brez glifov,
  // le {fact} kot vsebinski placeholder (korpus pošilja poved BREZ končne
  // pike -- piko doda predloga, enako kot pri trivia).
  podcastOpen: [
    'Živjo narod, tukaj Markec. Pet minut rocka, nič dolgčasanov, to obljubim in to držim.',
    'Pozdravljeni, jaz sem Markec, voditelj, ki zna vse o rocku, razen kdaj naj utihne.',
    'Dober dan, Markec pri mikrofonu, kitare so uglašene, pogovor pa napet. Gremo.',
    'Živjo! Pri mikrofonu je Markec, po poklicu voditelj, po poklicanosti pa vajenec za vse ostalo.',
  ],
  podcastChat: [
    'In zdaj kaj pametnega, da ne rečeš, da le vrtim plošče: {fact}. Se pravi, rock zgodovina je bolj norčava kot moj program.',
    'Malo zgodovine med skladbama: {fact}. Hahaha, kdo si to izmisli. Resnica, pravijo.',
    'Za pogovor pa tole: {fact}. To si zapomnite, bo prišlo prav na kvizu, ki ga ne bo.',
    'Zdaj pa resna minutka, ki je spet ni: {fact}. Če ste to vedeli, si zaslužite kavo. Če ne, dobrodošli v klub.',
  ],
  podcastLaugh: [
    'Hahaha, no ja, rock brez heca je samo hrup s fundamento.',
    'Ha, tole sem si moral napisati sam, drugi nočejo. Nazaj k glasbi.',
    'No ja, glede na to, koliko stojim pri mikrofonu, se čudim, da še vedno poslušate. Glasba naj gre naprej.',
  ],
  podcastOutro: [
    'To je bilo vse od marca. Markeca se razume, glasba pa naj se nadaljuje. Se vidimo!',
    'Pet minut je za nami, polnih rocka in heca. Hvala, ker ste bili tam, jaz pa smukam.',
    'Konec podkasta, konec heca, glasba teče naprej. Jaz sem Markec, nasvidenje!',
  ],

  // Paket B2 (docs/programming-research.md §5): promo clips -- the fourth
  // imaging layer (imaging/promos.m3u + radio.liq's promo_source), produced by
  // scheduler/promoProducer.js from the REAL schedule via Edge TTS. Two pools,
  // split by host presence exactly like live.nextShow above. {dayWord} is
  // ALWAYS the weekday-name form ("v torek") -- never "danes"/"jutri": a promo
  // clip lives in the pool for hours, so a relative word produced at 22:00
  // would rot after midnight; the weekday name stays true whenever it airs.
  // renderSlot's unknown-slot branch resolves these straight from
  // config.autoRadio.templates, so both pools are owner-overridable with no
  // code changes.
  promo: [
    'Na {station} {dayWord} ob {time}: {show}. Ne zamudite!',
    '{dayWord} ob {time} vas na {station} čaka {show} -- ostanite z nami!',
    'Napovedujemo: {show} {dayWord} ob {time}, tukaj na {station}. Ne zamudite!',
    '{dayWord} ob {time} -- {show} na {station}. Pridite, bo vredno.',
  ],
  promoHost: [
    'Na {station} {dayWord} ob {time}: {show} z voditeljem {host}. Ne zamudite!',
    '{dayWord} ob {time} vas na {station} čaka {show}, za mikrofonom pa {host} -- ostanite z nami!',
    'Napovedujemo: {show} z voditeljem {host}, {dayWord} ob {time}, tukaj na {station}. Ne zamudite!',
    '{dayWord} ob {time} -- {show} in {host} na {station}. Ne zamudite!',
  ],

  // Val 28 A2: STATION-level general clips (pre-generate-clips.mjs) -- the
  // open/close/handoff that air on every show in pregenerated mode. The
  // show-shaped pools above need {show}/{host}; these clips exist precisely
  // for show-less music blocks, so they get their own {station}-only pools
  // in the same relaxed register (they used to be three hardcoded texts
  // that aired verbatim on EVERY show -- the last fixed-formal surface).
  // Seed carries the local date (pre-generate-clips.mjs), so a re-run of the
  // script rotates the variant per day; owners override via
  // config.autoRadio.templates like every other pool.
  stationOpen: [
    'Dobrodošli na {station}. Uživajte v glasbi.',
    'Tako -- {station} je na nogah, glasba tudi. Kar se namestite.',
    'Pozdravljeni! {station} in dober zvok za vse.',
    'No, prižgimo: {station} vrti, vi pa kar ostanite.',
  ],
  stationClose: [
    'S tem je oddaja zaključena. Do naslednjega srečanja!',
    'To je to za danes. {station} ostaja prižgana.',
    'Za tokrat konec -- hvala, da ste bili z nami na {station}.',
    'Glasba pa ne gre spat, {station} tudi ne.',
  ],
  stationHandoff: [
    'Poglejmo še, kakšno vreme nas čaka.',
    'Kakšno je zunaj? Poglejmo še vreme.',
    'Vreme je na vrsti -- povejmo, kaj nas čaka zunaj.',
    'Zunaj se kaj dogaja? Napoved takoj sledi.',
  ],

  // Paket D1 (docs/programming-research.md §5): formatna ura -- the beds the
  // format clock speaks OVER the music (scheduler/formatClock.js, Edge TTS,
  // pushed via beds.push with the sidechain ducker). Two pools, each split by
  // the data actually available, exactly like weatherNow's temp/condition
  // split: bedWeather drops the wind clause when the API returned no wind,
  // bedNextShow drops the "z voditeljem" clause when the brief has no host
  // (substitute() would blank the value but keep the sentence shape).
  // {nextDayWord} is slovenianDayLabel RELATIVE TO THE FIRE MOMENT (the clip
  // is produced minutes before it fires, so a word relative to produce time
  // could rot across midnight); the promo pools above deliberately use the
  // absolute weekday form instead, because THOSE clips live in a pool for
  // hours. renderSlot's two branches below resolve these pools, so both are
  // owner-overridable via config.autoRadio.templates with no code changes.
  bedWeather: {
    withWind: [
      'Vreme na {station}: zunaj je {condition}, {temp} stopinj Celzija, veter piha s hitrostjo {wind} kilometrov na uro.',
      'Vremenski pregled {station}: {condition}, {temp} stopinj Celzija, veter {wind} kilometrov na uro.',
      '{station} poroča: zunaj je {condition}, {temp} stopinj, piha {wind} kilometrov na uro.',
      'Tako je zunaj na {station}: {condition}, {temp} stopinj, veter pa {wind} kilometrov na uro.',
    ],
    noWind: [
      'Vreme na {station}: zunaj je {condition}, {temp} stopinj Celzija.',
      'Vremenski pregled {station}: {condition}, {temp} stopinj.',
      '{station} poroča: zunaj je {condition}, {temp} stopinj Celzija.',
      'Tako je zunaj na {station}: {condition} in {temp} stopinj.',
    ],
  },
  bedNextShow: {
    withHost: [
      '{nextDayWord} ob {nextTime} vas na {station} čaka {show} z voditeljem {host} -- ostanite z nami!',
      'Ob {nextTime} na {station} začenja {show}, za mikrofonom pa {host} -- {nextDayWord} ne zamudite!',
      'Napovedujemo: {show} z voditeljem {host}, {nextDayWord} ob {nextTime}, tukaj na {station}.',
      '{nextDayWord} ob {nextTime} -- {show} in {host} na {station}. Kar ostanite.',
    ],
    noHost: [
      '{nextDayWord} ob {nextTime} vas na {station} čaka {show} -- ostanite z nami!',
      '{nextDayWord} ob {nextTime} na {station} začenja {show} -- ne zamudite!',
      'Napovedujemo: {show}, {nextDayWord} ob {nextTime}, tukaj na {station}.',
      '{nextDayWord} ob {nextTime} -- {show} na {station}. Kar ostanite.',
    ],
  },
};

// Val 27 "spro\u0161en register": the discourse markers the pools may sprinkle
// in -- at most ONE per variant, immediately before a comma or a dash (the
// "Tako je zunaj" shape is an opener, not a filler, and does not count).
// Exported for the register lint (test/voiceRegister.test.mjs), same
// surface style as DEFAULT_TEMPLATES above.
export const DISCOURSE_MARKERS = ['No', 'Tako', 'Glejte', 'Poglejte', 'Mhm'];

// WMO weather interpretation codes (Open-Meteo), in Slovenian -- mirrors the
// English map in director/weather.js so live lines speak the same facts in
// the station's template language.
const WEATHER_SLOVENIAN = {
  0: 'jasno',
  1: 'prete\u017eno jasno',
  2: 'delno obla\u010dno',
  3: 'obla\u010dno',
  45: 'meglovno',
  48: 'meglovno',
  51: 'rahla rosulja',
  53: 'rosulja',
  55: 'mo\u010dna rosulja',
  61: 'rahel de\u017e',
  63: 'de\u017e',
  65: 'mo\u010dan de\u017e',
  71: 'rahel sneg',
  73: 'sneg',
  75: 'mo\u010dan sneg',
  80: 'plohe',
  81: 'plohe',
  82: 'hude plohe',
  95: 'nevihta',
  96: 'nevihta s to\u010do',
  99: 'nevihta s to\u010do',
};

export function slovenianWeatherDescription(code) {
  return WEATHER_SLOVENIAN[code] ?? 'nenavadne razmere';
}

// ---------------------------------------------------------------------------
// variant selection + substitution
// ---------------------------------------------------------------------------

// FNV-1a over the seed string -- stable across runs, no dependency.
function hash(seed) {
  let h = 0x811c9dc5;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

// Config overrides deep-merge over the defaults: a config entry REPLACES the
// slot it names (so authors see exactly what they wrote run), while slots
// they leave untouched keep the Slovenian defaults.
function mergedTemplates() {
  const overrides = config.autoRadio?.templates ?? {};
  return { ...DEFAULT_TEMPLATES, ...overrides };
}

function variantFrom(pool, seed) {
  if (!pool?.length) return null;
  return pool[hash(seed) % pool.length];
}

function substitute(template, values) {
  return template.replace(/\{(\w+)\}/g, (whole, key) => {
    const v = values[key];
    return v == null || v === '' ? '' : String(v);
  });
}

// Picks a recap template matching the metadata actually available on the
// track, so we never read "iz albuma ." when the album tag is missing.
function recapPool(templates, track) {
  const pools = templates.recap;
  if (track?.album && track?.year) return pools.withAlbumYear;
  if (track?.year) return pools.withYear;
  return pools.generic;
}

// ---------------------------------------------------------------------------
// public API
// ---------------------------------------------------------------------------

// values: { station, show, artist, title, album, year, genre, to } plus
// internally-derived { block, time, date }.
export function renderSlot(slot, { values, seed, block }) {
  const templates = mergedTemplates();
  const blockValue = block ?? values.block ?? null;

  let pool;
  if (slot === 'open' || slot === 'close') {
    const slotPools = templates[slot];
    pool = (blockValue && slotPools[blockValue]) || slotPools.default;
  } else if (slot === 'recap') {
    pool = recapPool(templates, values.track ?? {});
  } else if (slot === 'intro' || slot === 'quizIntro' || slot === 'quizReveal' || slot === 'handoff') {
    pool = templates[slot];
  } else if (slot === 'live:nextShow') {
    // Paket B1: host-aware pool split, same pattern as weatherNow's
    // temp/condition split above -- a show with no host must never render a
    // dangling "z voditeljem" clause (substitute() would blank the host but
    // keep the sentence shape).
    pool = values.nextHost ? templates.live.nextShow.withHost : templates.live.nextShow.noHost;
  } else if (slot.startsWith('live:')) {
    pool = templates.live[slot.slice('live:'.length)];
  } else if (slot === 'bedWeather') {
    // Paket D1: wind-aware split (weatherNow's data-availability pattern):
    // no wind from the API -> the pool without the wind clause, never a
    // rendered "veter piha s hitrostjo  kilometrov" hole (substitute() blanks
    // the value but keeps the sentence shape).
    pool = values.wind != null && values.wind !== '' ? templates.bedWeather.withWind : templates.bedWeather.noWind;
  } else if (slot === 'bedNextShow') {
    // Paket D1: host-aware split, same rule as live:nextShow above.
    pool = values.host ? templates.bedNextShow.withHost : templates.bedNextShow.noHost;
  } else if (slot === 'weatherNow') {
    const pools = templates.weatherNow;
    pool = values.temp != null ? (values.condition ? pools.withTemp : pools.tempOnly) : pools.generic;
  } else if (slot === 'obzorje') {
    const pools = templates.obzorje;
    pool = pools[values.kindKey] ?? pools.birth;
  } else if (slot === 'obzorjeGlasba') {
    const pools = templates.obzorjeGlasba;
    pool = pools[values.kindKey] ?? pools.birth;
  } else {
    pool = templates[slot]; // unknown slots resolve straight from config
  }

  const template = variantFrom(pool, seed ?? slot);
  if (!template) {
    throw new Error(`No template configured for slot "${slot}" (block "${blockValue ?? '-'}").`);
  }
  return substitute(template, { ...values, block: blockValue });
}

// Context helpers shared by the auto producer and the auto live-line
// resolver -- one formatting for both, so script text and spoken text agree.

export function stationName() {
  return config.autoRadio?.stationName ?? 'Radio Markec';
}

export function showName(showTitle) {
  return showTitle ?? stationName();
}

export function currentValues() {
  const timezone = config.weather?.timezone ?? 'UTC';
  return {
    station: stationName(),
    time: currentLocalTimeString(timezone),
    date: currentLocalDateString(timezone),
  };
}

// Track context for intro/recap placeholders. decade derives from year when
// present; genre is the track's first tag (templates never enumerate).
export function trackValues(track) {
  const year = track?.year ?? null;
  return {
    artist: track?.artist ?? '',
    title: track?.title ?? '',
    album: track?.album ?? '',
    year: year ?? '',
    decade: year ? String(year - (year % 10)) + 's' : '',
    genre: track?.genre?.[0] ?? '',
  };
}
