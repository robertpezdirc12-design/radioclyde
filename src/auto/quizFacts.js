// Quiz corpus (P4 #22) -- the OFFLINE content for the "Kviz" rubric. While
// the legacy quiz position (auto/scriptBuilder.js quizIntro/quizReveal, the
// middle track of a brief with a quiz segment) guessed the track's own year
// from library metadata, this corpus carries REAL rock-music questions with
// one verifiable answer each, so the same on-air moment becomes an actual
// quiz. Zero network, zero model: like rockFacts.js, this file is a frozen
// operator decision.
//
// Ground rules for entries:
//   - only widely documented, non-controversial facts (multiple encyclopedias
//     agree); no "allegedly", no tabloid lore,
//   - `prompt` is ONE question ending with '?' -- the template pool adds the
//     "answer right after the song" promise, so the prompt must not contain it,
//   - `answer` is SHORT and UNIQUE: exactly one widely accepted response, and
//     it must NOT appear verbatim in the prompt (no giveaway questions),
//   - no trailing period on the answer (the template adds the punctuation),
//   - no template placeholders ({...} is reserved),
//   - `year` is the fact's anchor year -- entries stay sorted by year, so
//     rotation walks rock history roughly chronologically, mirroring the
//     zanimivosti corpus and the themed catalog that covers the same eras.
export const QUIZ_QUESTIONS = [
  { year: 1949, prompt: 'Kako je B.B. King poimenoval svoje kitare -- po \u017eenski, za katero se je v klubu v Twistu sprlo toliko ljudi, da je klub zgorel?', answer: 'Lucille' },
  { year: 1950, prompt: 'Pod katerim prvotnim imenom je Leo Fender predstavil svojo prvo masovno proizvedeno kitaro z masivnim telesom, danes znano kot Telecaster?', answer: 'Broadcaster' },
  { year: 1954, prompt: 'Kateri model kitare je Fender predstavil leta 1954 kot prvo masovno proizvedeno s tremolo ro\u010dico in tremi snemalniki?', answer: 'Stratocaster' },
  { year: 1955, prompt: 'Katera skladba Chucka Berryja je leta 1955 zapisala predlogo rocka o avtomobilih, dekletih in najstni\u0161ki hierarhiji?', answer: 'Maybellene' },
  { year: 1955, prompt: 'S katero skladbo je Little Richard leta 1955 vpeljal najbolj divjo stran zgodnjega rock\u2019n\u2019rolla?', answer: 'Tutti Frutti' },
  { year: 1958, prompt: 'Kateri Gibsonov model kitare, oblikovan po podobi reaktivnega lovca, je bil v prvi seriji izdelan le v pribli\u017eno osemdesetih kosih?', answer: 'Flying V' },
  { year: 1959, prompt: 'Kateri kitarist in pevec, znan po skladbi Peggy Sue, je umrl v letalski nesre\u010di 3. februarja 1959?', answer: 'Buddy Holly' },
  { year: 1962, prompt: 'Katera zalo\u017eba je januarja 1962 zavrnila The Beatles s pojasnilom, da skupine s kitarami izgubljajo modno veljavo?', answer: 'Decca' },
  { year: 1962, prompt: 'Po kateri pesmi Muddyja Watersa so se poimenovali The Rolling Stones?', answer: 'Rollin\u2019 Stone' },
  { year: 1964, prompt: 'V kateri ameri\u0161ki televizijski oddaji so februarja 1964 pred pribli\u017eno 73 milijoni gledalcev nastopili The Beatles?', answer: 'The Ed Sullivan Show' },
  { year: 1964, prompt: 'Od koder je 28. marca 1964 za\u010dela oddajati prva britanska piratska radijska postaja Radio Caroline?', answer: 'Severno morje' },
  { year: 1965, prompt: 'Na katerem folk festivalu je Bob Dylan julija 1965 priklju\u010dil elektri\u010dno kitaro?', answer: 'Newport' },
  { year: 1966, prompt: 'Kateri u\u010dinek na kitari je bil leta 1966 prvotno zasnovan kot imitacija zvoka trobente?', answer: 'Wah-wah' },
  { year: 1967, prompt: 'Na katerem festivalu je Jimi Hendrix junija 1967 za\u017egal svoj Fender Stratocaster?', answer: 'Monterey' },
  { year: 1967, prompt: 'Katera skupina je junija 1967 izdala album Sgt. Pepper\u2019s Lonely Hearts Club Band?', answer: 'The Beatles' },
  { year: 1967, prompt: 'V katerem mestu je postaja KMPX leta 1967 kot ena prvih na svetu rocku namenila celoten program?', answer: 'San Francisco' },
  { year: 1968, prompt: 'Iz katere skupine je leta 1968 nastal Led Zeppelin?', answer: 'The Yardbirds' },
  { year: 1969, prompt: 'Kak\u0161no ime je nosila skupina Black Sabbath, preden se je leta 1969 preimenovala?', answer: 'Earth' },
  { year: 1969, prompt: 'Kateri album iz oktobra 1969 velja za rojstvo progresivnega rocka?', answer: 'In the Court of the Crimson King' },
  { year: 1969, prompt: 'Koliko ljudi je avgusta 1969 med de\u017ejem in blatom pre\u017eivelo festival Woodstock?', answer: 'okoli 400.000' },
  { year: 1970, prompt: 'Iz katere skupine so nastali Queen, ko se jim je leta 1970 pridru\u017eil pevec Farrokh \u00bbFreddie\u00ab Bulsara?', answer: 'Smile' },
  { year: 1971, prompt: 'Katera skupina je o po\u017earu kasina v Montreuxu napisala Smoke on the Water?', answer: 'Deep Purple' },
  { year: 1971, prompt: 'Pod katerim vzdevkom je znan \u010detrti album Led Zeppelinov, ki uradno ni nosil imena?', answer: 'Album \u0161tirih simbolov' },
  { year: 1972, prompt: 'Kateri scenski alter ego je David Bowie leta 1972 poslal na oder in dokazal, da je lahko rock tudi gledali\u0161\u010de?', answer: 'Ziggy Stardust' },
  { year: 1973, prompt: 'V kateri grozljivki je zaslovel glavni motiv Tubular Bells Mikea Oldfielda?', answer: 'Priklic' },
  { year: 1973, prompt: 'Kateri album Pink Floyd je marca 1973 na ameri\u0161kih lestvicah ostal rekordno dolgo -- ve\u010d kot desetletje?', answer: 'The Dark Side of the Moon' },
  { year: 1975, prompt: 'Kdo je decembra 1975 ustanovil Iron Maiden?', answer: 'Steve Harris' },
  { year: 1975, prompt: 'Koliko podvojenih vokalov naj bi vseboval operni del skladbe Bohemian Rhapsody?', answer: 'pribli\u017eno 180' },
  { year: 1976, prompt: 'S katerim albumom sta sestri Ann in Nancy Wilson s skupino Heart leta 1976 trdno stopili v hard rock?', answer: 'Dreamboat Annie' },
  { year: 1977, prompt: 'Katero pesem Sex Pistols je BBC leta 1977 prepovedal?', answer: 'God Save the Queen' },
  { year: 1977, prompt: 'Kateri slovenski punkovski bend je nastal v Ljubljani leta 1977?', answer: 'Pankrti' },
  { year: 1978, prompt: 'S katerim instrumentalom je Eddie Van Halen leta 1978 preporodil tehniko igranja elektri\u010dne kitare?', answer: 'Eruption' },
  { year: 1978, prompt: 'S katero skladbo je Kate Bush leta 1978 kot prva \u017eenska z lastnorazpeto pesmijo zasedla vrh britanske lestvice?', answer: 'Wuthering Heights' },
  { year: 1980, prompt: 'Kdo je zapel kot novi pevec AC/DC na albumu Back in Black?', answer: 'Brian Johnson' },
  { year: 1981, prompt: 'Kateri videospot je 1. avgusta 1981 odprl program televizije MTV?', answer: 'Video Killed the Radio Star' },
  { year: 1982, prompt: 'S katero skladbo je Joan Jett leta 1982 sedem tednov vladala ameri\u0161ki lestvici?', answer: 'I Love Rock\u2019n\u2019Roll' },
  { year: 1985, prompt: 'Na katerem dobrodelnem koncertu je Queen julija 1985 odigrala dvajsetminutni nastop, pozneje izvoljen za najbolj\u0161ega \u017eivega koncerta v zgodovini rocka?', answer: 'Live Aid' },
  { year: 1986, prompt: 'Kateri album iz leta 1986 mnogi imenujejo najve\u010dji heavy metal album vseh \u010dasov?', answer: 'Master of Puppets' },
  { year: 1987, prompt: 'Katera podoba je zamenjala prvotni ovitek albuma Appetite for Destruction skupine Guns N\u2019 Roses?', answer: 'kri\u017e z lobanjami' },
  { year: 1991, prompt: 'Kateri album je januarja 1992 podrl Michaela Jacksona z vrha ameri\u0161ke lestvice?', answer: 'Nevermind' },
];

// Same FNV-1a as templates.js / voice.js / rockFacts.js -- stable across
// runs, no dependency.
function hash(seed) {
  let h = 0x811c9dc5;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

// Picks up to `count` quiz questions deterministically from the corpus. The
// seed (typically `${showId}|${date}`) makes one occurrence always ask the
// same question (reproducible transcripts, cacheable audio) while different
// days rotate through rock history; `usedPrompts` (questions already asked
// in this show) are skipped, so a future second quiz position can never
// repeat a question within one occurrence.
export function pickQuizQuestions(count, seed = 'quiz', usedPrompts = new Set()) {
  if (count <= 0 || QUIZ_QUESTIONS.length === 0) return [];
  const start = hash(String(seed)) % QUIZ_QUESTIONS.length;
  const picked = [];
  for (let offset = 0; offset < QUIZ_QUESTIONS.length && picked.length < count; offset++) {
    const item = QUIZ_QUESTIONS[(start + offset) % QUIZ_QUESTIONS.length];
    if (usedPrompts.has(item.prompt)) continue;
    picked.push(item);
    usedPrompts.add(item.prompt);
  }
  return picked;
}
