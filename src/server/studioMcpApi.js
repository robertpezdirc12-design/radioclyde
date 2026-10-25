// Oddaljeni MCP prenos (HTTP): POST /studio/api/mcp je ISTO JSON-RPC 2.0
// jedro (src/mcp/protocol.js, createMcpServer -> handleLine) kot stdio
// strežnik (src/mcp/server.js), le da sporočilo pride kot telo HTTP zahteve
// in odgovor odpove Fastify. Namen: AI odjemalec, ki ne more zagnati
// lokalnega stdio procesa (oddaljen stroj, kontejner), lahko upravlja
// postajo prek javnega strežnika.
//
// PARITETA ZAUPANJA: ta površina ima NATANČNO isto moč (isti 29-orodni
// katalog) in NATANČNO isto avtentikacijo kot vsaka druga studio pisalna
// pot -- /studio vtičnikov onRequest hook (studio Basic realm,
// config.studio.users, studioAuth.js) je edina vrata, tu notri NI dodatnega
// žetona. Oddaljeni MCP pakira obstoječo studio moč, ne dviguje je: kar lahko
// odjemalec naredi prek POST /studio/api/mcp, bi uporabnik z istimi
// poverilnicami naredil tudi prek /studio/api/* rut ali spletne plošče.
//
// PRIVZETO IZKLOPLJENO: mcp.remote.enabled === true je izrecna privolitev
// (precedens web.publicPaths -- ODSOTNOST ne pomeni "vklopljeno", ker je
// oddaljeni dostop sprememba zaupanja, ne tehnična podrobnost). Izklopljena
// RUTA se sploh NE registrira: odgovor je 404, ne 503 (precedens
// streamProxy.js:58-60, "a disabled mount must 404, route absent").
// Konfiguracija se zamrzne ob zagonu strežnika: preklop mcp.remote zahteva
// RESTART POSTAJE (systemctl restart radioclyde) -- nasprotje stdio zgodbe,
// kjer je MCP strežnik ločen proces, ki ga požene/zaustavi odjemalec.
//
// POT JE BREZ PREDPONE /studio (lekcija Vala 17-b): modul se registrira
// ZNOTRAJ /studio vtičnika (fastify.register v studioAuth.js), zato
// fastify.post('/api/mcp') dejansko odgovarja na /studio/api/mcp; lastna
// predpona bi pomenila dvojno /studio/studio/api/mcp = 404 v produkciji
// (napaka, ki je pred 17-b pokosila studio Podkast ploščo).
import { config } from '../config/index.js';
import { createLogger } from '../lib/logger.js';
import { TOOLS, resolveMcpFlags } from '../mcp/tools.js';
import { createMcpServer } from '../mcp/protocol.js';

// Ena vrstica na POST v isti dnevnik, kamor pisalna orodja že pišejo svoje
// podrobne vrstice (src/mcp/tools.js: audit = createLogger('mcp')) --
// <dataDir>/logs/mcp.log. Opomba: console.log iz logger.js v STANIČNEM
// procesu je neškodljiv (stdout postaje ni JSON-RPC tok); čistost
// stdouta je pogodba stdio procesa, ki ta modul nikoli ne naloži (server.js
// preusmeri console.log, preden naloži karkoli iz src/).
const log = createLogger('mcp');

// Čisti odločitveni prestreznik (en parameter za vse uporabnike): true SAMO
// če je mcp.enabled !== false IN mcp.remote.enabled === true. Izvožen, ker
// ga testi preverjajo kot enoto in ker je to edina definicija "oddaljeni
// prenos je vklopljen".
export function mcpRemoteEnabled(cfg) {
  return cfg?.mcp?.enabled !== false && cfg?.mcp?.remote?.enabled === true;
}

// host[:port] razcep, ki preživi IPv6 literal v oglatih oklepajih: dvopičja
// ZNOTRAJ oklepajev niso ločilo vrat, pravi dvopiče je tisto za zadnjim ']' .
function splitHostPort(value) {
  const lastColon = value.lastIndexOf(':');
  const bracketEnd = value.indexOf(']');
  if (lastColon === -1 || (bracketEnd !== -1 && lastColon < bracketEnd)) {
    return [value, ''];
  }
  return [value.slice(0, lastColon), value.slice(lastColon + 1)];
}

// Obramba Origin (DNS-rebinding): brskalnik pošlje Origin glavo ob vsakem
// cross-site fetch(), AI CLI odjemalci je ne pošiljajo nikoli. Obstoječa
// Origin, katere gostitelj (z vrati, kadar jih Origin nosi -- URL sicer
// privzetih vrat ne izpiše) ni enak gostitelju zahteve (glava Host), pomeni,
// da brskalnik na DRUGI strani poskuša predvajati predpomniljene studio
// Basic poverilnice -> 403. Ista stran gre skozi; brez Origin (CLI) tudi.
function originAllowed(request) {
  const origin = request.headers.origin;
  if (origin === undefined) return true; // CLI odjemalec -- glavni oddaljeni uporabnik
  let originHost;
  try {
    originHost = new URL(origin).host;
  } catch {
    return false; // Origin, ki ni URL, ni iz poštenega brskalnika (npr. sandbox "null")
  }
  const hostHeader = request.headers.host;
  if (typeof hostHeader !== 'string' || !hostHeader) return false; // ni s čim primerjati -> odkloni, ne ugibaj
  if (originHost === hostHeader) return true;
  const [originBare, originPort] = splitHostPort(originHost);
  const [hostBare, hostPort] = splitHostPort(hostHeader);
  if (originBare !== hostBare) return false;
  if (!originPort) {
    // Origin brez vrat pomeni shema-privzeta vrata; sprejmi Host, ki jih
    // izpiše (npr. ":443" za TLS preddverje) ali prav tako izpusti.
    return !hostPort || hostPort === '80' || hostPort === '443';
  }
  return originPort === hostPort;
}

// Ena vrstica na POST: od kje (request.ip), kaj (JSON-RPC metoda, če
// razčlenljiva) in izid (ok / napaka / isError / obvestilo). Pisalna orodja
// že zapišejo svoje podrobne vrstice v isti dnevnik -- to je samo "kdo je
// prišel po HTTP in kaj je vprašal", ne podvajanje.
function auditRemote(request, raw, out) {
  let method = '(nerazčlenljivo)';
  try {
    const parsed = JSON.parse(String(raw));
    if (Array.isArray(parsed)) method = '(batch)';
    else if (parsed && typeof parsed === 'object' && typeof parsed.method === 'string') method = parsed.method;
  } catch {
    /* raw ni JSON -- metoda ostane (nerazčlenljivo) */
  }
  let outcome = '?';
  if (out === null) {
    outcome = 'obvestilo (202)';
  } else {
    try {
      const parsed = JSON.parse(out);
      if (parsed.error) outcome = `napaka ${parsed.error.code}`;
      else if (parsed.result?.isError) outcome = 'isError';
      else outcome = 'ok';
    } catch {
      /* izhod jedra je vedno veljaven JSON -- teoretska veja */
    }
  }
  log(`remote ${request.ip} ${method} -> ${outcome}`);
}

export function registerStudioMcpApi(fastify) {
  // Samo-vrata: izklopljen oddaljeni prenos = ruta sploh ne obstaja (404),
  // streamProxy.js disciplina. Ni tu nobene 503 "izklopljeno" rute -- razglasitev
  // površine bi bila samo vabilo.
  if (!mcpRemoteEnabled(config)) return;

  // ENA instanca jedra, sestavljena ob registraciji NATANČNO kot stdio vhod
  // (src/mcp/server.js:61-67): isti TOOLS katalog, isti serverInfo, isto
  // allowWriteTools stikalo (resolveMcpFlags). Edina razlika je configOk:
  // tu je konfiguracija že uspešno naložena (slaba konfiguracija bi stanični
  // proces sploh ne pognala), zato je vedno true. Brez toolContexta --
  // produkcijski backend (tools.js ga lenobno naloži sam), ne testni šiv.
  const mcp = createMcpServer({
    tools: TOOLS,
    serverInfo: { name: 'radioclyde-mcp', version: '0.1.0' },
    configOk: true,
    allowWriteTools: resolveMcpFlags(config).allowWriteTools,
  });

  // Omejen (scoped) content-type parser: telo application/json pride kot
  // NEPREBRAN NIZ, ker je protocol.js edini lastnik VSEH JSON-RPC semantik --
  // pokvarjen JSON mora odgovoriti -32700 iz jedra, ne Fastifyeva lastna
  // napaka razčlenjevanja. Ta parser je razlog, da je modul registriran
  // ENKAPSULIRANO (fastify.register v studioAuth.js): Fastify ob vsakem
  // vtičniku zgradi KOPIJO parserjev (plugin-override.js:46), zato se
  // nizovni parser NE razlije na sestrske studio rute. Fastify tak parser
  // ujame tudi parameterizirane glave ('application/json; charset=utf-8' ->
  // zadetek po mediaType, node_modules/fastify/lib/content-type-parser.js
  // getParser), pasovi-spodaj veja pokriva vse preostale primere.
  fastify.addContentTypeParser(
    'application/json',
    { parseAs: 'string' },
    (req, body, done) => done(null, body)
  );

  fastify.post('/api/mcp', async (request, reply) => {
    if (!originAllowed(request)) {
      log(`remote ${request.ip} (tuji Origin) -> 403`);
      return reply.code(403).send({ error: 'Origin glava se ne ujema z gostiteljem zahteve.' });
    }
    // Pasovi in naramnice: če bi kakršen koli content-type variant obšel
    // nizovni parser (star odjemalec, bodoča Fastify sprememba), objektno
    // telo le pretvorimo nazaj v niz -- semantika ostane jedrova.
    const raw =
      typeof request.body === 'string'
        ? request.body
        : request.body == null
          ? ''
          : JSON.stringify(request.body);
    // handleLine je ASINHRONA (protocol.js:172) -- await je obvezen, sicer
    // bi bil `out` Obljuba in bi vsak odgovor razpadel.
    const out = await mcp.handleLine(raw);
    auditRemote(request, raw, out);
    if (out === null) {
      // Obvestilo (sporočilo brez id) -- jedro nikoli ne odgovarja; 202
      // pomeni "sprejeto, odgovora ni" (dogovor JSON-RPC-over-HTTP).
      return reply.code(202).send();
    }
    const body = JSON.parse(out);
    // -32700 (pokvarjen JSON) in -32600 (batch) sta napaki ZAHTEVKA same --
    // ju pošljemo kot 400. Vse ostalo potuje kot 200 s JSON-RPC telesom:
    // -32601/-32602/-32603 in isError izidi orodij so odgovori protokola,
    // ne napake transporta (standarden JSON-RPC-over-HTTP).
    if (body.error && (body.error.code === -32700 || body.error.code === -32600)) {
      return reply.code(400).send(body);
    }
    return reply.code(200).send(body);
  });

  // GET bi pomenil SSE tok dogodkov (streamable HTTP transport), ki ga ta
  // površina namerno NIMA -- spec sankcionira odklon: 405 s pošteno {error},
  // ne tihi 404, ki bi bil videti kot "ruta ne obstaja".
  fastify.get('/api/mcp', async (request, reply) => {
    return reply.code(405).send({
      error: 'Oddaljeni MCP prenos je brez stanja: pošlji JSON-RPC sporočilo s POST.',
    });
  });

  // Brez sej: strežnik nikoli ne izda Mcp-Session-Id, vhodnih prezre in
  // MCP-Protocol-Version glavo ignorira (različico protokola jedro samo
  // odmeva iz initialize). DELETE bi brisal sejo -- sej ni, zato 405.
  fastify.delete('/api/mcp', async (request, reply) => {
    return reply.code(405).send({ error: 'Oddaljeni MCP prenos je brez sej: ni ničesar za brisati.' });
  });
}
