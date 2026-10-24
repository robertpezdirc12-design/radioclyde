// Push dispatch job -- enkrat na minuto pogleda urnik in poslje obvestila
// oddajam, ki se zacikajo v naslednjih config.push.leadMinutes minutah.
//
// Zavoljan do okolja: brez narocnin je tik ena mala branja (JSON, ~nič); ce
// pa katerikoli korak pade, gre napaka v schedulerjev LOG ("push_dispatch
// ERROR: ...") -- tik nikoli ne strmoglavi procesa in ne ubije jobov, ki
// so registrirani ZA njim (F2-razred defekta, varen, ker startScheduler
// vsako registracijo ovije z lastnim try/catch -- a se vseeno drzimo
// ?. disciplzne tudi tukaj).
//
// Ime oddaje v obvestilu razresi prek show briefa (isti resolveShowInfo kot
// /api/schedule), zato obvestilo rece "Markec Podkast", ne "markec-podkast".
import { dispatchPush } from '../push/dispatch.js';
import { resolveShowInfo } from '../server/showName.js';
import { createLogger } from '../lib/logger.js';

const log = createLogger('station');

export async function pushDispatchTick() {
  const report = await dispatchPush({
    nameResolver: (show) => resolveShowInfo(show, show.specialTitle ?? show.id).name ?? show.id,
  });
  if (report.due > 0) {
    log(
      `push_dispatch: oddaj ${report.due}, dostavljeno ${report.delivered}, ` +
        `napake ${report.failed}, obrezano ${report.pruned}`
    );
  }
  return report;
}
