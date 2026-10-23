import { startOnAirView } from './onAir.js';
import { startShowsView } from './shows.js';
import { startScheduleView } from './schedule.js';
import { startPromptsView } from './prompts.js';
import { startRequestsView } from './requests.js';
import { startLibraryView } from './library.js';
import { startVoiceView } from './voice.js';
import { startDiagnosticsView } from './diagnostics.js';

const VIEWS = ['on-air', 'shows', 'schedule', 'prompts', 'requests', 'library', 'voice', 'diagnostics'];
const STARTERS = {
  'on-air': startOnAirView,
  shows: startShowsView,
  schedule: startScheduleView,
  prompts: startPromptsView,
  requests: startRequestsView,
  library: startLibraryView,
  voice: startVoiceView,
  diagnostics: startDiagnosticsView,
};
const started = new Set();

function currentView() {
  const hash = location.hash.replace('#', '');
  return VIEWS.includes(hash) ? hash : 'on-air';
}

function showView(view) {
  for (const v of VIEWS) {
    document.getElementById(`view-${v}`).hidden = v !== view;
  }
  for (const link of document.querySelectorAll('.nav-list a')) {
    link.classList.toggle('active', link.dataset.view === view);
  }
  // Each view's starter fetches its own data on first activation -- On Air
  // additionally sets up its own polling interval, matching the public
  // site's page's existing pattern (public/app.js).
  if (!started.has(view)) {
    started.add(view);
    STARTERS[view]();
  } else if (['shows', 'schedule', 'prompts', 'requests', 'library', 'voice'].includes(view)) {
    // Re-fetch on every visit for views that don't self-poll, so a stale
    // client doesn't show data another tab (or the scheduler) already
    // changed on disk.
    STARTERS[view]();
  }
}

window.addEventListener('hashchange', () => showView(currentView()));
showView(currentView());
