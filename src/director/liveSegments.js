// Live-segment lines, resolved at direct time. Real data first (deterministic
// weather fetch, or the server clock for time -- no network call for the
// time kinds), then the fact set is dropped into the station's configured
// live template pool (auto/liveLines.js -> auto/templates.js), with the
// weather code described in Slovenian from the same WMO table mapping. Same
// facts, same templates, every time -- no model anywhere.
//
// Val 28 ("samo skripte brez AI modelov"): this file used to branch on
// config.autoRadio.enabled into an LM Studio completion (qwen3.6-35b-a3b)
// that wrote the line from an English fact sheet under a persona system
// prompt. That branch is REMOVED -- the template resolver is the only path,
// so there is exactly one voice on air: the station's own pools.
//
// `occurrence` ({ show, weekday, date, timeKey }, director/index.js's own
// directShow arguments) is the occurrence identity the nextShow kind needs;
// the time/weather kinds ignore it entirely.
import { resolveLiveLineAuto } from '../auto/liveLines.js';

export async function resolveLiveLine({ persona, kind, brief }, occurrence = null) {
  return resolveLiveLineAuto({ persona, kind, brief, occurrence });
}
