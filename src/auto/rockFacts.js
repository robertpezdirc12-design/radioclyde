// General rock-history trivia corpus (P4 #17) -- the OFFLINE half of the
// "Zanimivosti" rubric. While the per-artist half (auto/trivia.js) asks
// MusicBrainz / sl.wikipedia about whoever is about to play, this corpus
// carries the GENERAL rock facts the station can tell with zero network:
// guitars, albums, concerts, bands, radio history -- in Slovenian, curated
// by hand, one full sentence per entry, WITHOUT a trailing period (the
// template pool that renders it adds the punctuation).
//
// Ground rules for entries:
//   - only widely documented, non-controversial facts (the kind multiple
//     encyclopedias agree on); no "allegedly", no tabloid lore,
//   - one sentence, no template placeholders ({...} is reserved),
//   - `year` is the fact's anchor year (or null when the fact is era-less)
//     -- entries stay sorted by year, so rotation walks rock history
//     roughly chronologically instead of jumping at random,
//   - Slovenian facts belong here too (Pankrti, Buldozer) -- the station is
//     Slovenian and its general trivia should know where it lives.
export const GENERAL_ROCK_FACTS = [
  { year: 1931, text: 'Prvi elektri\u010dni kitari sta leta 1931 izumila George Beauchamp in Adolph Rickenbacker -- model sta zaradi oblike v \u0161ali imenovala Ponva' },
  { year: 1950, text: 'Leo Fender je leta 1950 predstavil Telecaster, prvo masovno proizvedeno elektri\u010dno kitaro z masivnim telesom; prvotno se je imenovala Broadcaster' },
  { year: 1951, text: 'Leo Fender je leta 1951 predstavil Precision Bass, prvo masovno proizvedeno elektri\u010dno basovsko kitaro' },
  { year: 1951, text: 'Plo\u0161\u010do Rocket 88 iz leta 1951, posneto s prepo\u010denim oja\u010devalnikom, mnogi \u0161tejejo za prvo rock\u2019n\u2019rollsko pesem' },
  { year: 1952, text: 'Gibson je leta 1952 za\u010del prodajati model Les Paul, ki ga je pod vodstvom Teda McCartynega razvil skupaj z glasbenikom Lesom Paulom' },
  { year: 1954, text: 'Fender Stratocaster iz leta 1954 je prva masovno proizvedena kitara s tremolo ro\u010dico in tremi snemalniki' },
  { year: 1954, text: 'Elvis Presley je julija 1954 v memphi\u0161kem studiu Sun posnel That\u2019s All Right -- plo\u0161\u010do, ki jo \u0161tejejo za rojstvo rockabillyja' },
  { year: 1955, text: 'Chuck Berry je z Maybellene leta 1955 zapisal predlogo rocka o avtomobilih, dekletih in najstni\u0161ki hierarhiji' },
  { year: 1955, text: 'Little Richard je leta 1955 s Tutti Frutti vpeljal najbolj divjo stran zgodnjega rock\u2019n\u2019rolla' },
  { year: 1958, text: 'Gibson je leta 1958 predstavil model Flying V, oblikovan po podobi reaktivnega lovca; iz prve serije je iz\u0161lo le pribli\u017eno osemdeset kosov' },
  { year: 1959, text: 'V letalski nesre\u010di 3. februarja 1959 je umrl Buddy Holly; Don McLean je ta dan pozneje poimenoval Dan, ko je glasba umrla' },
  { year: 1962, text: 'Zalo\u017eba Decca je januarja 1962 zavrnila The Beatles z utemeljitvijo, da skupine s kitarami izgubljajo modno veljavo' },
  { year: 1962, text: 'The Rolling Stones so prvi\u010d nastopili 12. julija 1962 v londonskem klubu Marquee' },
  { year: 1964, text: 'Nastop The Beatles v ameri\u0161ki oddaji Eda Sullivana februarja 1964 je gledalo pribli\u017eno 73 milijonov ljudi -- tedaj rekord televizije' },
  { year: 1964, text: 'Radio Caroline je 28. marca 1964 za\u010dela oddajati z ladje v Severnem morju -- prva britanska piratska postaja, ki je rocku odprla pot mimo konservativnega radia' },
  { year: 1965, text: 'Ko je Bob Dylan julija 1965 na folk festivalu v Newportu priklju\u010dil elektri\u010dno kitaro, je del publike vi\u017eal -- rodil se je folk rock' },
  { year: 1965, text: 'Riff za (I Can\u2019t Get No) Satisfaction je Keith Richards posnel sredi no\u010di na kasetofon, sam in zaspan' },
  { year: 1965, text: 'Pink Floyd je nastal v Londonu leta 1965; ime si je izmislil Syd Barrett po dveh blues glasbenikih, Pinku Andersonu in Floydu Councilu' },
  { year: 1966, text: 'Wah-wah pedalo je bilo leta 1966 prvotno zasnovano kot imitacija zvoka trobente, a sta ga Jimi Hendrix in Eric Clapton spremenila v glas rocka' },
  { year: 1967, text: 'Jimi Hendrix je junija 1967 na festivalu v Montereyju za\u017egal svoj Fender Stratocaster -- ena najslavnej\u0161ih scen v zgodovini rocka' },
  { year: 1967, text: 'Album Sgt. Pepper\u2019s Lonely Hearts Club Band je junija 1967 pokazal, da je lahko rock album umetnina -- pogosto ga imenujejo prva konceptualna plo\u0161\u010da' },
  { year: 1967, text: 'Postaja KMPX v San Franciscu je leta 1967 kot ena prvih na svetu rocku namenila celoten program' },
  { year: 1969, text: 'Festival Woodstock avgusta 1969 je med de\u017ejem in blatom pre\u017eivelo okoli 400.000 ljudi; nastopilo je 32 izvajalcev' },
  { year: 1970, text: 'Queen so nastali leta 1970 iz skupine Smile, ko se jim je pridru\u017eil pevec Farrokh \u00bbFreddie\u00ab Bulsara in predlagal novo ime' },
  { year: 1970, text: 'Prvi album Black Sabbath je iz\u0161el februarja 1970 in po splo\u0161nem mnenju za\u010del zgodovino heavy metala' },
  { year: 1970, text: 'Aprila 1970 se je raz\u0161la The Beatles -- za sabo je pustila 12 studijskih albumov in desetletje, ki je spremenilo glasbo' },
  { year: 1971, text: 'Decembra 1971 je med koncertom Franka Zappe v Montreuxu gorel kasino -- Deep Purple je o po\u017earu napisal Smoke on the Water' },
  { year: 1972, text: 'David Bowie je leta 1972 na oder poslal Ziggyja Stardusta in dokazal, da je lahko rock tudi gledali\u0161\u010de' },
  { year: 1973, text: 'Pink Floyd je marca 1973 izdal The Dark Side of the Moon, ki je na ameri\u0161kih lestvicah ostal rekordno dolgo -- ve\u010d kot desetletje' },
  { year: 1973, text: 'Buldo\u017eer, ena od prvih prog-rock skupin na prostorih biv\u0161e Jugoslavije, je nastala v Ljubljani sredi sedemdesetih' },
  { year: 1973, text: 'AC/DC sta v Sydneyu leta 1973 ustanovila brata Malcolm in Angus Young; Angus \u0161e danes nastopa v \u0161olski uniformi' },
  { year: 1975, text: 'Queen so Bohemian Rhapsody posneli v \u0161tirih razli\u010dnih studiih; operni del skladbe naj bi vseboval pribli\u017eno 180 podvojenih vokalov' },
  { year: 1977, text: 'BBC je leta 1977 prepovedal God Save the Queen skupine Sex Pistols; pesem je kljub prepovedi poletela visoko na lestvice' },
  { year: 1977, text: 'Pankrti, prvi slovenski punkovski bend, so nastali v Ljubljani leta 1977; Lepi in be\u017eec velja za enega od prvih punkovskih singlov v Jugoslaviji' },
  { year: 1978, text: 'Eddie Van Halen je leta 1978 z instrumentalom Eruption preporodil tehniko igranja elektri\u010dne kitare' },
  { year: 1981, text: 'Metallica je nastala leta 1981 v Los Angelesu, ko je bobnar Lars Ulrich prek oglasa v reviji na\u0161el kitarista Jamesa Hetfielda' },
  { year: 1981, text: 'Televizija MTV je 1. avgusta 1981 za\u010dela oddajati z videospotom Video Killed the Radio Star -- glasba je sprehodila v vizualni vek' },
  { year: 1985, text: 'Queen je julija 1985 na koncertu Live Aid v Wembleyu odigrala dvajsetminutni nastop, ki so ga pozneje izvolili za najbolj\u0161i \u017eivi koncert v zgodovini rocka' },
  { year: 1987, text: 'Prvotni ovitek albuma Appetite for Destruction skupine Guns N\u2019 Roses so trgovine zavra\u010dale, zato ga je zamenjal znameniti kri\u017e z lobanjami' },
  { year: 1991, text: 'Nirvanin album Nevermind je januarja 1992 podrl Michaela Jacksona z vrha ameri\u0161ke lestvice -- za\u010del se je grunge' },
];

// Same FNV-1a as templates.js / voice.js -- stable across runs, no dependency.
function hash(seed) {
  let h = 0x811c9dc5;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

// Picks `count` general facts deterministically from the corpus. The seed
// (typically `${showId}|${date}`) makes one occurrence always render the
// same set, while different days start at different points in rock history.
// `usedTexts` (facts already told in this show) are skipped, so the corpus
// never repeats itself within one show even when `count` would wrap around.
export function pickGeneralRockFacts(count, seed = 'trivia', usedTexts = new Set()) {
  const corpus = GENERAL_ROCK_FACTS;
  if (count <= 0 || corpus.length === 0) return [];
  const start = hash(String(seed)) % corpus.length;
  const picked = [];
  for (let offset = 0; offset < corpus.length && picked.length < count; offset++) {
    const fact = corpus[(start + offset) % corpus.length];
    if (usedTexts.has(fact.text)) continue;
    picked.push(fact);
    usedTexts.add(fact.text);
  }
  return picked;
}
