// Markec Podkast kartica v pogledu Shows: status zadnje epizode + gumb
// "Izdelaj današnjo epizodo". Isti cevovod kot CLI (strežnik kliče
// auto/podcastPipeline.js), zato tu ne nastane nobena dodatna resnica --
// samo drug gumb do iste datoteke. Piper + ffmpeg trajata desetine sekund:
// gumb se med izdelavo izklopi, 409 (že teče) pa je prikazan kot sporočilo.
import { api } from './api.js';

const statusEl = document.getElementById('podkast-status');
const makeButton = document.getElementById('podkast-make-button');
const forceEl = document.getElementById('podkast-force');

let wired = false;

function fmtSeconds(s) {
  if (!Number.isFinite(s)) return '';
  const total = Math.round(s);
  const m = Math.floor(total / 60);
  const ss = String(total % 60).padStart(2, '0');
  return `${m}:${ss}`;
}

function renderStatus(data) {
  if (data.running) {
    statusEl.textContent = 'Izdelava teče -- Piper izgovarja, ffmpeg sestavlja. To traja desetine sekund.';
    return;
  }
  const last = data.lastEpisode;
  if (!last) {
    statusEl.textContent = 'Še ni nobene epizode. Gumb zgradi današnjo: skripta + Piper zvok + prave skladbe.';
    return;
  }
  const trajanje = Number.isFinite(last.seconds) ? `, ${fmtSeconds(last.seconds)} zvoka` : '';
  const zvok = last.hasAudio ? `zvok NA disku${trajanje}` : 'brez zvoka (samo skripta -- poglej doctor ali CLI za razlog)';
  statusEl.textContent = `Zadnja: ${last.date} -- ${last.title} (${zvok}).`;
}

async function refresh() {
  try {
    renderStatus(await api('/api/podcast'));
  } catch (err) {
    statusEl.textContent = `Status ni na voljo: ${err.message}`;
  }
}

export function startPodkastCard() {
  refresh();
  if (wired) return;
  wired = true;
  makeButton.addEventListener('click', async () => {
    makeButton.disabled = true;
    statusEl.textContent = 'Izdelava teče -- Piper izgovarja, ffmpeg sestavlja. To traja desetine sekund.';
    try {
      const result = await api('/api/podcast', {
        method: 'POST',
        body: { force: forceEl.checked },
      });
      const how = result.reused ? 'Današnja epizoda je že na disku (reuse -- za novo izdelavo uporabi --force).' : 'Epizoda izdelana.';
      const zvok = result.audio ? ` Zvok: ${fmtSeconds(result.audio.seconds)} s, ${result.audio.pieces} poglavij.` : '';
      statusEl.textContent = `${how}${zvok} Objavljena na strani "Podkast" in v RSS.`;
    } catch (err) {
      statusEl.textContent = `Napaka: ${err.message}`;
    } finally {
      makeButton.disabled = false;
      refresh();
    }
  });
}
