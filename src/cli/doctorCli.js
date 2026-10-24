#!/usr/bin/env node
// Predvečerna diagnostika (P4 #31) -- EN ukaz, ki operaterju PRED terminirano
// uro pove, ali bo oddaja preživela: konfiguracija, podatkovna mapa, govor,
// knjižnica, ledger, korpusi in (z --net) dostopnost virov.
//
//   npm run doctor [-- --net] [-- --json]
//
// --net   sproži omrežne preverjanje virov (ARSO, RTV x2, Wikidata, Open-Meteo)
//         s kratkim časovnim zamikom; mrtvi vir je OPOZORILO, ne napaka --
//         točno tako kot v programu (P4 #28–#30: rubrika poje pošteno vrstico,
//         radio igra dalje). Brez --net je ta blok označen kot preskočen.
// --json  strojni izpis (ena sam JSON objekt na stdout) za cron/monitoring.
//
// Zakaj dinamičen import configa: zlomljen config.json je STANJE, ki ga
// doctor mora sporočiti -- statičen import bi pomenil crash pred prvo
// vrstico izpisa. Z try/catch ga ujamemo in ga kot NAPAKO poročamo
// prek checkConfig(Error), ostale preverjanja pa korektno preskočimo.
import { parseArgs } from '../lib/args.js';

const args = parseArgs(process.argv.slice(2));
const netProbe = Boolean(args.net);
const asJson = Boolean(args.json);

const statusMarker = { ok: 'OK', warn: 'OPZ', fail: 'NAPAKA', skip: 'PRESK' };

function renderHuman({ results, verdict }) {
  const lines = [];
  lines.push('Radio Markec -- predvečerna diagnostika');
  lines.push('='.repeat(60));
  for (const r of results) {
    const marker = (statusMarker[r.status] ?? r.status).padEnd(6, ' ');
    lines.push(`  ${marker} ${r.label.padEnd(24, ' ')} ${r.detail}`);
  }
  lines.push('='.repeat(60));
  lines.push(`Sklep: ${verdict}`);
  return lines.join('\n');
}

let configOrError = null;
try {
  configOrError = (await import('../config/index.js')).config;
} catch (err) {
  configOrError = err instanceof Error ? err : new Error(String(err));
}

const { runDoctor } = await import('../auto/doctor.js');
const report = await runDoctor({ configOrError, netProbe });

if (asJson) {
  console.log(JSON.stringify({
    when: new Date().toISOString(),
    netProbe,
    results: report.results,
    verdict: report.verdict,
    exitCode: report.exitCode,
  }, null, 2));
} else {
  console.log(renderHuman(report));
  if (!netProbe) {
    console.log('(omrežni viri so preskočeni -- poženi "npm run doctor -- --net" za dostopnost)');
  }
}
process.exit(report.exitCode);
