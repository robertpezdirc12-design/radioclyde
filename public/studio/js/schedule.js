import { api } from './api.js';

// 2.5px/minute -- a 30min show is 75px tall, giving the title/time/badge
// room to breathe. (The original 0.625px/min scale made blocks ~19px tall,
// which is what made dragging unreliable and text illegible -- see git
// history/conversation for why this got bumped, first to 2, then to 2.5 once
// 2px still felt cramped with the readiness badge added.)
const PX_PER_MIN = 2.5;
const DAY_HEIGHT = 24 * 60 * PX_PER_MIN;
const WEEKDAYS = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'];
const DAY_LABELS = { monday: 'Mon', tuesday: 'Tue', wednesday: 'Wed', thursday: 'Thu', friday: 'Fri', saturday: 'Sat', sunday: 'Sun' };
// Every real show is a 30min slot -- snapping drag/resize/add to the same
// grain keeps the grid always landing on a clean boundary instead of
// producing odd times like 07:13.
const DRAG_SNAP_MIN = 30;

// One categorical color per show, so the grid reads at a glance instead of
// every block being the same blue. Each {bg, fg} pair is validated
// (dataviz skill's validate_palette.js, --mode light): all 8 pass the CVD
// and normal-vision separation gates in this fixed order; fg is picked per
// bg for real WCAG contrast (aqua/yellow/magenta read badly with white text
// despite passing the palette-vs-page-background check, so those three get
// dark text instead). With ~29 real shows there are always more shows than
// colors -- colorForShow() hashes the id to a stable slot, and the block's
// own title text (always visible) is what actually disambiguates when two
// shows land on the same color, not the color alone.
const SHOW_COLORS = [
  { bg: '#2a78d6', fg: '#ffffff' }, // blue
  { bg: '#eb6834', fg: '#111827' }, // orange
  { bg: '#1baf7a', fg: '#111827' }, // aqua
  { bg: '#eda100', fg: '#111827' }, // yellow
  { bg: '#e87ba4', fg: '#111827' }, // magenta
  { bg: '#008300', fg: '#ffffff' }, // green
  { bg: '#4a3aa7', fg: '#ffffff' }, // violet
  { bg: '#e34948', fg: '#111827' }, // red
];

function colorForShow(id) {
  let hash = 0;
  for (let i = 0; i < id.length; i++) hash = (hash * 31 + id.charCodeAt(i)) >>> 0;
  return SHOW_COLORS[hash % SHOW_COLORS.length];
}

const scrollEl = document.getElementById('schedule-scroll');
const gridEl = document.getElementById('schedule-grid');
const popoverEl = document.getElementById('schedule-popover');
const toastEl = document.getElementById('schedule-toast');
// Paket C1 (Val 22): the Datumi (date overrides) list + its "add a date" form.
const datesListEl = document.getElementById('schedule-dates-list');
const datesEmptyEl = document.getElementById('schedule-dates-empty');
const dateNewInput = document.getElementById('schedule-date-new');
const dateAddButton = document.getElementById('schedule-date-add');

let currentSchedule = {};
let showTitles = {}; // id -> title, for block labels and the popover's <select>
let currentReadiness = {}; // "weekday/time-key" -> 'directed' | 'script' | 'none', today/tomorrow only
let currentDates = {}; // Paket C1: "YYYY-MM-DD" -> occurrences[] (the schedule.dates overrides)
let toastTimer = null;
let hasScrolledToDay = false;

// A drag/resize that the server rejects (e.g. it wouldn't fit) has no form
// to show the error in -- a transient toast instead of a blocking alert(),
// since alert() freezes the whole page (confirmed while testing: it stalls
// the tab until dismissed) for an error that's often just "picked a bad
// spot, try again."
function showToast(message) {
  toastEl.textContent = message;
  toastEl.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { toastEl.hidden = true; }, 4000);
}

function minutesToTime(totalMinutes) {
  const clamped = Math.max(0, Math.min(23 * 60 + 59, totalMinutes));
  const h = Math.floor(clamped / 60);
  const m = clamped % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

function timeToMinutes(t) {
  const [h, m] = t.split(':').map(Number);
  return h * 60 + m;
}

function timeKeyOf(startTime) {
  return startTime.replace(':', '-');
}

// Date#getDay() is Sun=0..Sat=6; WEEKDAYS starts Monday, so shift by 6 (mod
// 7) to land on the same index scheduleUtil.js's weekdayKey() would produce.
function todayWeekday() {
  return WEEKDAYS[(new Date().getDay() + 6) % 7];
}

function nowMinutes() {
  const now = new Date();
  return now.getHours() * 60 + now.getMinutes();
}

function endTimeLabel(occ) {
  return minutesToTime(timeToMinutes(occ.startTime) + occ.durationMinutes);
}

function closePopover() {
  popoverEl.hidden = true;
  popoverEl.innerHTML = '';
}

// Anchors the popover near (x, y) in viewport coordinates, clamped so it
// never renders off the right/bottom edge of the window.
function openPopoverAt(x, y, buildContent, width = 250) {
  popoverEl.innerHTML = '';
  const header = document.createElement('div');
  header.className = 'schedule-popover-header';
  const closeButton = document.createElement('button');
  closeButton.type = 'button';
  closeButton.className = 'schedule-popover-close';
  closeButton.textContent = '×';
  closeButton.addEventListener('click', closePopover);
  header.append(buildContent.title, closeButton);
  popoverEl.appendChild(header);
  popoverEl.appendChild(buildContent.body);

  popoverEl.hidden = false;
  // Paket C1: the dates popover needs more room than a weekday slot's; the
  // stylesheet default stays 250px, so an explicit width is pinned inline.
  popoverEl.style.width = `${width}px`;
  const left = Math.min(x, window.innerWidth - width - 16);
  popoverEl.style.left = `${Math.max(8, left)}px`;
  const height = popoverEl.offsetHeight || 200;
  const top = Math.min(y, window.innerHeight - height - 16);
  popoverEl.style.top = `${Math.max(8, top)}px`;
}

async function loadShowTitles() {
  const { shows } = await api('/api/shows');
  showTitles = Object.fromEntries(shows.map((s) => [s.id, s.title]));
}

function makeShowSelect(selectedId) {
  const select = document.createElement('select');
  for (const [id, title] of Object.entries(showTitles).sort(([, a], [, b]) => a.localeCompare(b))) {
    const opt = document.createElement('option');
    opt.value = id;
    opt.textContent = title;
    if (id === selectedId) opt.selected = true;
    select.appendChild(opt);
  }
  return select;
}

function makeHeaderCell(text, isToday, weekday, hasDateOverride) {
  const el = document.createElement('div');
  el.className = isToday ? 'schedule-day-header is-today' : 'schedule-day-header';
  const label = document.createElement('span');
  label.textContent = text;
  el.appendChild(label);
  // Paket C1 (Val 22): a chip when this weekday's next real date carries an
  // override -- the column still shows the TEMPLATE (the Datumi list below
  // is the override truth), the chip just says "this template won't air that
  // date". Inline styles follow this file's per-block inline-style precedent.
  if (hasDateOverride) {
    const chip = document.createElement('span');
    chip.textContent = 'datumski prenos';
    chip.title = 'V prihajajočem tednu ima ta dan datumski prenos — prikazana predloga tega dne ne bo šla v eter (glej Datumi spodaj).';
    chip.style.marginLeft = '6px';
    chip.style.fontSize = '0.62rem';
    chip.style.fontWeight = '700';
    chip.style.padding = '1px 6px';
    chip.style.borderRadius = '4px';
    chip.style.border = '1px solid var(--border)';
    chip.style.background = 'var(--bg)';
    chip.style.color = 'var(--muted)';
    chip.style.verticalAlign = 'middle';
    chip.style.whiteSpace = 'nowrap';
    el.appendChild(chip);
  }
  if (weekday) {
    // Keyboard-reachable "add" affordance: the empty-column click path reads
    // the pointer's Y to pick a start time, so it is pointer-only. This
    // button opens the same popover without a pointer; its start time
    // defaults to the next half-hour boundary (the grid's snap grain),
    // which the popover's owner can still change via the weekday/time path.
    const add = document.createElement('button');
    add.type = 'button';
    add.className = 'btn btn-small';
    // btn-small alone is ~26px tall -- inline sizing for the touch target,
    // same pattern as the per-block inline styles elsewhere in this file.
    add.style.minHeight = '44px';
    add.style.minWidth = '44px';
    add.style.marginLeft = '6px';
    add.style.verticalAlign = 'middle';
    add.textContent = '+';
    add.setAttribute('aria-label', `Dodaj oddajo na ${DAY_LABELS[weekday]}`);
    add.title = 'Dodaj oddajo';
    add.addEventListener('click', () => {
      const startTime = minutesToTime((Math.floor(nowMinutes() / DRAG_SNAP_MIN) + 1) * DRAG_SNAP_MIN);
      const rect = add.getBoundingClientRect();
      openAddPopover(weekday, startTime, rect.left, rect.bottom + 6);
    });
    el.appendChild(add);
  }
  return el;
}

// A live line across today's column at the current time, the same idea as
// Google Calendar's "now" marker -- otherwise there's no way to tell, at a
// glance, where "now" falls in a grid that's a recurring weekly template
// with no dates on it. Re-run both on every render() (which tears down and
// rebuilds the whole grid) and on its own interval (see startScheduleView())
// so it keeps creeping forward between renders too.
function updateNowLine() {
  const col = gridEl.querySelector(`.schedule-day-column[data-day="${todayWeekday()}"]`);
  if (!col) return;
  let line = col.querySelector('.schedule-now-line');
  if (!line) {
    line = document.createElement('div');
    line.className = 'schedule-now-line';
    const label = document.createElement('span');
    label.className = 'schedule-now-line-label';
    line.appendChild(label);
    col.appendChild(line);
  }
  const minutes = nowMinutes();
  line.style.top = `${minutes * PX_PER_MIN}px`;
  line.querySelector('.schedule-now-line-label').textContent = minutesToTime(minutes);
}

// Only 'directed' and 'script' get a badge -- 'none'/missing (not due yet,
// or today/tomorrow doesn't cover this slot) looks the same as "not ready"
// and needs no visual noise on a grid that's mostly slots nothing has
// touched yet (see the /api/schedule/readiness comment for why). Reuses the
// same status-dot/status-live/status-pending classes the On Air page uses,
// so "green = ready" reads the same way in both places.
const READINESS_META = {
  directed: { statusClass: 'status-live', label: 'Ready to air -- script and audio are directed.' },
  script: { statusClass: 'status-pending', label: 'Script ready, audio not directed yet.' },
};

function makeReadinessBadge(weekday, occ) {
  const status = currentReadiness[`${weekday}/${timeKeyOf(occ.startTime)}`];
  const meta = READINESS_META[status];
  if (!meta) return null;
  const badge = document.createElement('div');
  badge.className = `schedule-block-readiness status-dot ${meta.statusClass}`;
  badge.title = meta.label;
  return badge;
}

function makeBlock(weekday, occ) {
  const el = document.createElement('div');
  el.className = 'schedule-block';
  el.style.top = `${timeToMinutes(occ.startTime) * PX_PER_MIN}px`;
  el.style.height = `${Math.max(occ.durationMinutes * PX_PER_MIN, 26)}px`;
  const { bg, fg } = colorForShow(occ.id);
  el.style.background = bg;
  el.style.color = fg;

  const handle = document.createElement('div');
  handle.className = 'schedule-block-handle';
  handle.title = 'Drag to move';
  handle.textContent = '⋮⋮';

  const body = document.createElement('div');
  body.className = 'schedule-block-body';
  const title = document.createElement('div');
  title.className = 'schedule-block-title';
  title.textContent = showTitles[occ.id] ?? occ.id;
  const time = document.createElement('div');
  time.className = 'schedule-block-time';
  time.textContent = `${occ.startTime}–${endTimeLabel(occ)}`;
  body.append(title, time);
  // Keyboard path into the edit popover: the body acts as a button --
  // Enter/Space open the same popover a click does. Arrow-key move/resize
  // stays deliberately unwired; the popover's time and duration fields are
  // the keyboard path for those.
  body.tabIndex = 0;
  body.setAttribute('role', 'button');
  body.setAttribute('aria-label', `Uredi: ${showTitles[occ.id] ?? occ.id} ${occ.startTime}–${endTimeLabel(occ)}`);
  body.addEventListener('click', () => openEditPopover(weekday, occ, body.getBoundingClientRect()));
  body.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    event.preventDefault(); // Space would scroll the grid instead of activating
    openEditPopover(weekday, occ, body.getBoundingClientRect());
  });

  const resizeHandle = document.createElement('div');
  resizeHandle.className = 'schedule-block-resize';

  el.append(handle, body, resizeHandle);
  const readinessBadge = makeReadinessBadge(weekday, occ);
  if (readinessBadge) el.appendChild(readinessBadge);
  // Paket C2 (Val 22): a replay occurrence renders like any other block
  // (this function only consumes id/startTime/durationMinutes) plus a ↻
  // badge with the source date -- the weekly TEMPLATE can legitimately carry
  // a replay (e.g. every Tuesday re-airs Sunday's episode).
  if (occ.type === 'replay') {
    const replayBadge = document.createElement('span');
    replayBadge.textContent = '↻';
    replayBadge.title = `ponovitev ${occ.sourceDate ?? ''}`;
    replayBadge.setAttribute('aria-label', `ponovitev ${occ.sourceDate ?? ''}`);
    replayBadge.style.marginLeft = '4px';
    time.appendChild(replayBadge);
  }

  wireDrag(handle, el, weekday, occ);
  wireResize(resizeHandle, el, weekday, occ);
  return el;
}

function openEditPopover(weekday, occ, anchorRect) {
  const title = document.createElement('strong');
  title.textContent = `${DAY_LABELS[weekday]} · ${occ.startTime}–${endTimeLabel(occ)}`;

  const body = document.createElement('div');
  body.style.display = 'flex';
  body.style.flexDirection = 'column';
  body.style.gap = '0.5rem';

  const select = makeShowSelect(occ.id);
  body.appendChild(select);

  const actions = document.createElement('div');
  actions.className = 'form-actions';
  const saveButton = document.createElement('button');
  saveButton.type = 'button';
  saveButton.className = 'btn btn-primary';
  saveButton.textContent = 'Save';
  const deleteButton = document.createElement('button');
  deleteButton.type = 'button';
  deleteButton.className = 'btn btn-danger';
  deleteButton.textContent = 'Delete';
  actions.append(saveButton, deleteButton);
  body.appendChild(actions);

  const messageEl = document.createElement('span');
  messageEl.className = 'action-message';
  body.appendChild(messageEl);

  saveButton.addEventListener('click', async () => {
    if (select.value === occ.id) return closePopover();
    messageEl.textContent = 'Saving...';
    try {
      await api(`/api/schedule/${weekday}/${timeKeyOf(occ.startTime)}`, {
        method: 'PATCH',
        body: { id: select.value },
      });
      closePopover();
      await render();
    } catch (err) {
      messageEl.textContent = err.message;
      messageEl.classList.add('error');
    }
  });

  deleteButton.addEventListener('click', async () => {
    if (!confirm(`Remove "${showTitles[occ.id] ?? occ.id}" from ${DAY_LABELS[weekday]} ${occ.startTime}?`)) return;
    try {
      await api(`/api/schedule/${weekday}/${timeKeyOf(occ.startTime)}`, { method: 'DELETE' });
      closePopover();
      await render();
    } catch (err) {
      messageEl.textContent = err.message;
      messageEl.classList.add('error');
    }
  });

  openPopoverAt(anchorRect.left, anchorRect.bottom + 6, { title, body });
}

function openAddPopover(weekday, startTime, clientX, clientY) {
  const title = document.createElement('strong');
  title.textContent = `Add to ${DAY_LABELS[weekday]}`;

  const body = document.createElement('div');
  body.style.display = 'flex';
  body.style.flexDirection = 'column';
  body.style.gap = '0.5rem';

  const select = makeShowSelect(null);
  const durationInput = document.createElement('input');
  durationInput.type = 'number';
  durationInput.min = '1';
  durationInput.value = '30';
  durationInput.placeholder = 'Duration (minutes)';
  body.append(select, durationInput);

  const actions = document.createElement('div');
  actions.className = 'form-actions';
  const addButton = document.createElement('button');
  addButton.type = 'button';
  addButton.className = 'btn btn-primary';
  addButton.textContent = 'Add';
  actions.appendChild(addButton);
  body.appendChild(actions);

  const messageEl = document.createElement('span');
  messageEl.className = 'action-message';
  body.appendChild(messageEl);

  addButton.addEventListener('click', async () => {
    messageEl.textContent = 'Adding...';
    try {
      await api(`/api/schedule/${weekday}`, {
        method: 'POST',
        body: { id: select.value, startTime, durationMinutes: Number(durationInput.value) },
      });
      closePopover();
      await render();
    } catch (err) {
      messageEl.textContent = err.message;
      messageEl.classList.add('error');
    }
  });

  openPopoverAt(clientX, clientY, { title, body });
}

// Dragging is only ever started from the dedicated handle -- no click-vs-
// drag guessing needed, so clicking a show's title/time always reliably
// opens the popover (see makeBlock's body click listener) and grabbing the
// handle always reliably moves it.
function wireDrag(handle, el, weekday, occ) {
  handle.addEventListener('pointerdown', (startEvent) => {
    startEvent.preventDefault();
    closePopover();
    const startY = startEvent.clientY;
    const startTop = parseFloat(el.style.top);
    let dropColumn = el.parentElement;
    el.classList.add('dragging');

    const onMove = (moveEvent) => {
      const deltaY = moveEvent.clientY - startY;
      el.style.top = `${Math.max(0, startTop + deltaY)}px`;
      const target = document.elementFromPoint(moveEvent.clientX, moveEvent.clientY);
      const column = target?.closest('.schedule-day-column');
      if (column && column !== dropColumn) {
        dropColumn.classList.remove('drop-target');
        dropColumn = column;
        dropColumn.classList.add('drop-target');
      }
    };
    const onUp = async (upEvent) => {
      document.removeEventListener('pointermove', onMove);
      document.removeEventListener('pointerup', onUp);
      el.classList.remove('dragging');
      dropColumn.classList.remove('drop-target');

      const deltaY = upEvent.clientY - startY;
      const rawMinutes = (startTop + deltaY) / PX_PER_MIN;
      const snapped = Math.round(rawMinutes / DRAG_SNAP_MIN) * DRAG_SNAP_MIN;
      const newStartTime = minutesToTime(snapped);
      const newWeekday = dropColumn.dataset.day;

      try {
        if (newWeekday === weekday) {
          await api(`/api/schedule/${weekday}/${timeKeyOf(occ.startTime)}`, {
            method: 'PATCH',
            body: { startTime: newStartTime },
          });
        } else {
          // Cross-day move: POST to the target weekday FIRST, DELETE the
          // source only after that succeeded. The old order (DELETE, then
          // POST) permanently lost the occurrence from BOTH days whenever
          // the POST failed -- a 400 "no room left" from reorderAndPack or
          // a network drop landed after the DELETE had already gone through.
          await api(`/api/schedule/${newWeekday}`, {
            method: 'POST',
            body: { id: occ.id, startTime: newStartTime, durationMinutes: occ.durationMinutes, description: occ.description },
          });
          try {
            await api(`/api/schedule/${weekday}/${timeKeyOf(occ.startTime)}`, { method: 'DELETE' });
          } catch (err) {
            // The target copy exists but the source delete failed: restore
            // the source copy so the schedule never silently loses the
            // occurrence. If the DELETE was merely rejected (the source slot
            // is still occupied), the restore can leave a momentary
            // duplicate -- visible in the grid and fixable by hand; silent
            // divergence is not fixable at all.
            try {
              await api(`/api/schedule/${weekday}`, {
                method: 'POST',
                body: { id: occ.id, startTime: occ.startTime, durationMinutes: occ.durationMinutes, description: occ.description },
              });
              showToast(`Prestavitev ni uspela (${err.message}) -- oddaja je ostala na izvornem dnevu.`);
            } catch (rollbackErr) {
              showToast(`Prestavitev ni uspela (${err.message}); povrnitev na izvorni dan prav tako ni uspela (${rollbackErr.message}) -- preveri urnik ročno.`);
            }
          }
        }
      } catch (err) {
        showToast(err.message);
      }
      await render();
    };
    document.addEventListener('pointermove', onMove);
    document.addEventListener('pointerup', onUp);
  });
}

function wireResize(handle, el, weekday, occ) {
  handle.addEventListener('pointerdown', (startEvent) => {
    startEvent.preventDefault();
    startEvent.stopPropagation();
    closePopover();
    const startY = startEvent.clientY;
    const startHeight = parseFloat(el.style.height);
    el.classList.add('dragging');

    const onMove = (moveEvent) => {
      const deltaY = moveEvent.clientY - startY;
      el.style.height = `${Math.max(26, startHeight + deltaY)}px`;
    };
    const onUp = async (upEvent) => {
      document.removeEventListener('pointermove', onMove);
      document.removeEventListener('pointerup', onUp);
      el.classList.remove('dragging');
      const deltaY = upEvent.clientY - startY;
      const rawMinutes = (startHeight + deltaY) / PX_PER_MIN;
      const snapped = Math.max(DRAG_SNAP_MIN, Math.round(rawMinutes / DRAG_SNAP_MIN) * DRAG_SNAP_MIN);
      try {
        await api(`/api/schedule/${weekday}/${timeKeyOf(occ.startTime)}`, {
          method: 'PATCH',
          body: { durationMinutes: snapped },
        });
      } catch (err) {
        showToast(err.message);
      }
      await render();
    };
    document.addEventListener('pointermove', onMove);
    document.addEventListener('pointerup', onUp);
  });
}

// --- Paket C1 (Val 22): date overrides ("Datumi") --------------------------
//
// schedule.dates["YYYY-MM-DD"] replaces a WHOLE calendar day (that date's
// weekday template is suppressed, never merged). The weekly grid above
// stays a weekday-template view on purpose -- the division is honest: the
// grid answers "what does a normal <weekday> look like", this list answers
// "which real dates break out of it". No drag-and-drop here (v1 scope): a
// date override is edited as ONE list, because SAVE is a full-day PUT
// (replaceDateSchedule semantics) -- per-slot dragging would need the
// cross-store rollback dance the weekday grid already carries, for a
// surface that changes a handful of days a year.

const SL_DAY_NAMES = {
  monday: 'ponedeljek',
  tuesday: 'torek',
  wednesday: 'sreda',
  thursday: 'četrtek',
  friday: 'petek',
  saturday: 'sobota',
  sunday: 'nedelja',
};

// "YYYY-MM-DD" -> this file's WEEKDAYS index of that calendar date (local
// calendar arithmetic, the same convention as the server's dateFromKey +
// weekdayKey pair). A garbage key degrades to '?' in the label, never a
// crash -- the reader it came from is fail-open by doctrine.
function weekdayOfDateKey(key) {
  const [y, m, d] = key.split('-').map(Number);
  if (!Number.isFinite(y) || !Number.isFinite(m) || !Number.isFinite(d)) return null;
  return WEEKDAYS[(new Date(y, m - 1, d).getDay() + 6) % 7];
}

function dateKeyOf(date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

// Slovenian plural for the row's entry count; the empty case is the dark-day
// marker, spelled out so "0 entries" can never be mistaken for a mistake.
function dateEntriesLabel(entries) {
  if (entries.length === 0) return 'prazen dan — samo filler';
  const mod100 = entries.length % 100;
  if (entries.length === 1) return '1 vnos';
  if (mod100 === 2) return '2 vnosa';
  if (mod100 >= 3 && mod100 <= 4) return `${entries.length} vnosi`;
  return `${entries.length} vnosov`;
}

function renderDates() {
  datesListEl.replaceChildren();
  const keys = Object.keys(currentDates).sort();
  datesEmptyEl.hidden = keys.length > 0;
  for (const date of keys) {
    const entries = currentDates[date] ?? [];
    const li = document.createElement('li');

    const dateEl = document.createElement('span');
    dateEl.className = 'time';
    dateEl.textContent = date;

    const metaEl = document.createElement('span');
    metaEl.style.flex = '1';
    metaEl.style.minWidth = '0';
    const weekdayName = SL_DAY_NAMES[weekdayOfDateKey(date)] ?? '?';
    metaEl.textContent = `${weekdayName} · ${dateEntriesLabel(entries)}`;
    if (entries.length === 0) metaEl.classList.add('muted');

    const actions = document.createElement('span');
    actions.style.display = 'flex';
    actions.style.gap = '0.35rem';
    const editButton = document.createElement('button');
    editButton.type = 'button';
    editButton.className = 'btn btn-small';
    editButton.textContent = 'Uredi';
    editButton.setAttribute('aria-label', `Uredi datumski prenos za ${date}`);
    editButton.addEventListener('click', () => {
      const rect = editButton.getBoundingClientRect();
      openDatePopover(date, rect.left, rect.bottom + 6);
    });
    const deleteButton = document.createElement('button');
    deleteButton.type = 'button';
    deleteButton.className = 'btn btn-small btn-danger';
    deleteButton.textContent = 'Izbriši';
    deleteButton.setAttribute('aria-label', `Izbriši datumski prenos za ${date}`);
    deleteButton.addEventListener('click', async () => {
      if (!confirm(`Odstrani datumski prenos za ${date}? Ta dan bo spet sledil svoji tedenski predlogi.`)) return;
      try {
        await api(`/api/schedule/dates/${date}`, { method: 'DELETE' });
        await render();
      } catch (err) {
        showToast(err.message);
      }
    });
    actions.append(editButton, deleteButton);

    li.append(dateEl, metaEl, actions);
    datesListEl.appendChild(li);
  }
}

// One row inside the date popover: title + time range (+ ↻ for a replay),
// edit and remove. `occ` is an entry of the popover's working copy.
function makeDateEntryRow(occ, { onEdit, onRemove }) {
  const row = document.createElement('div');
  row.style.display = 'flex';
  row.style.justifyContent = 'space-between';
  row.style.alignItems = 'center';
  row.style.gap = '0.4rem';

  const label = document.createElement('span');
  label.style.minWidth = '0';
  label.style.overflow = 'hidden';
  label.style.textOverflow = 'ellipsis';
  label.style.whiteSpace = 'nowrap';
  label.textContent = `${showTitles[occ.id] ?? occ.id} ${occ.startTime}–${endTimeLabel(occ)}`;
  // Replay entries render unchanged plus this badge: the row reads as a
  // normal slot, the ↻ says "this one re-airs an existing episode".
  if (occ.type === 'replay') {
    const replay = document.createElement('span');
    replay.textContent = ' ↻';
    replay.title = `ponovitev ${occ.sourceDate ?? ''}`;
    replay.setAttribute('aria-label', `ponovitev ${occ.sourceDate ?? ''}`);
    label.appendChild(replay);
  }

  const actions = document.createElement('span');
  actions.style.display = 'flex';
  actions.style.gap = '0.3rem';
  const edit = document.createElement('button');
  edit.type = 'button';
  edit.className = 'btn btn-small';
  edit.textContent = 'Uredi';
  edit.addEventListener('click', onEdit);
  const remove = document.createElement('button');
  remove.type = 'button';
  remove.className = 'btn btn-small btn-danger';
  remove.textContent = '×';
  remove.setAttribute('aria-label', `Odstrani vnos ${occ.startTime}`);
  remove.addEventListener('click', onRemove);
  actions.append(edit, remove);

  row.append(label, actions);
  return row;
}

// The per-date popover: edits a LOCAL working copy of the day's occurrences
// (add / edit / remove entries inside the popover) and SAVE sends the entire
// day in one PUT -- full replacement, exactly replaceDateSchedule's
// semantics. Canceling (× or navigating away) leaves station.json untouched,
// so opening a date "to look" can never half-edit it.
function openDatePopover(date, clientX, clientY) {
  const weekdayName = SL_DAY_NAMES[weekdayOfDateKey(date)] ?? '?';
  const title = document.createElement('strong');
  title.textContent = `${date} · ${weekdayName}`;

  const body = document.createElement('div');
  body.style.display = 'flex';
  body.style.flexDirection = 'column';
  body.style.gap = '0.5rem';

  // LOUD by design: this is the one surface where SAVE can wipe a whole
  // day's template, so the copy states what saving does before it's done.
  const warning = document.createElement('p');
  warning.className = 'muted';
  warning.style.margin = '0';
  warning.style.fontWeight = '600';
  warning.textContent = 'Nadomesti celoten dan — tedenska predloga za ta datum ne velja.';
  body.appendChild(warning);

  const entriesEl = document.createElement('div');
  entriesEl.style.display = 'flex';
  entriesEl.style.flexDirection = 'column';
  entriesEl.style.gap = '0.3rem';
  body.appendChild(entriesEl);

  const formEl = document.createElement('div'); // the add/edit entry form, shown on demand
  formEl.hidden = true;
  body.appendChild(formEl);

  const actions = document.createElement('div');
  actions.className = 'form-actions';
  const saveButton = document.createElement('button');
  saveButton.type = 'button';
  saveButton.className = 'btn btn-primary';
  saveButton.textContent = 'Shrani cel dan';
  const messageEl = document.createElement('span');
  messageEl.className = 'action-message';
  actions.append(saveButton, messageEl);
  body.appendChild(actions);

  // The working copy -- plain clones, mutated only through the form below.
  const working = (currentDates[date] ?? []).map((occ) => ({ ...occ }));

  const openEntryForm = (existing) => {
    formEl.hidden = false;
    formEl.replaceChildren();
    formEl.style.display = 'flex';
    formEl.style.flexDirection = 'column';
    formEl.style.gap = '0.4rem';
    formEl.style.borderTop = '1px solid var(--border)';
    formEl.style.paddingTop = '0.5rem';

    const heading = document.createElement('strong');
    heading.textContent = existing ? `Uredi vnos ${existing.startTime}` : 'Nov vnos';
    formEl.appendChild(heading);

    const select = makeShowSelect(existing?.id ?? null);

    const startTimeInput = document.createElement('input');
    startTimeInput.type = 'text';
    startTimeInput.placeholder = 'Začetek (HH:MM)';
    startTimeInput.value = existing?.startTime ?? '';
    startTimeInput.setAttribute('aria-label', 'Začetek (HH:MM)');

    const durationInput = document.createElement('input');
    durationInput.type = 'number';
    durationInput.min = '1';
    durationInput.placeholder = 'Trajanje (minute)';
    durationInput.value = existing ? String(existing.durationMinutes) : '30';
    durationInput.setAttribute('aria-label', 'Trajanje v minutah');

    // Replay fields (Paket C2): a replay slot re-airs an existing episode
    // instead of producing a fresh one. sourceTimeKey is optional -- left
    // empty it means "the first occurrence of that show on sourceDate".
    const replayCheck = document.createElement('input');
    replayCheck.type = 'checkbox';
    const replayLabel = document.createElement('label');
    replayLabel.style.display = 'flex';
    replayLabel.style.alignItems = 'center';
    replayLabel.style.gap = '0.4rem';
    replayLabel.append(replayCheck, document.createTextNode('Ponovitev (replay) obstoječe epizode'));
    const sourceDateInput = document.createElement('input');
    sourceDateInput.type = 'text';
    sourceDateInput.placeholder = 'Datum vira (YYYY-MM-DD)';
    sourceDateInput.value = existing?.sourceDate ?? '';
    sourceDateInput.setAttribute('aria-label', 'Datum vira ponovitve');
    const sourceTimeKeyInput = document.createElement('input');
    sourceTimeKeyInput.type = 'text';
    sourceTimeKeyInput.placeholder = 'Čas vira (HH-MM, neobvezno)';
    sourceTimeKeyInput.value = existing?.sourceTimeKey ?? '';
    sourceTimeKeyInput.setAttribute('aria-label', 'Čas vira ponovitve');
    const sourceFields = document.createElement('div');
    sourceFields.style.display = 'flex';
    sourceFields.style.flexDirection = 'column';
    sourceFields.style.gap = '0.4rem';
    sourceFields.append(sourceDateInput, sourceTimeKeyInput);
    const syncReplayFields = () => {
      sourceFields.hidden = !replayCheck.checked;
    };
    replayCheck.addEventListener('change', syncReplayFields);
    if (existing?.type === 'replay') replayCheck.checked = true;
    syncReplayFields();
    // Reassigning the show makes a replay's source stale (sourceDate points
    // at the OLD show's episode) -- the same rule the server applies to
    // weekday id-patches, applied here as an uncheck so the operator
    // re-decides with visible fields.
    select.addEventListener('change', () => {
      if (existing && select.value !== existing.id) {
        replayCheck.checked = false;
        syncReplayFields();
      }
    });

    const formActions = document.createElement('div');
    formActions.className = 'form-actions';
    const applyButton = document.createElement('button');
    applyButton.type = 'button';
    applyButton.className = 'btn btn-primary';
    applyButton.textContent = existing ? 'Shrani vnos' : 'Dodaj vnos';
    const cancelButton = document.createElement('button');
    cancelButton.type = 'button';
    cancelButton.className = 'btn';
    cancelButton.textContent = 'Prekliči';
    const formMessage = document.createElement('span');
    formMessage.className = 'action-message';
    formActions.append(applyButton, cancelButton, formMessage);

    formEl.append(select, startTimeInput, durationInput, replayLabel, sourceFields, formActions);

    cancelButton.addEventListener('click', () => {
      formEl.hidden = true;
      formEl.replaceChildren();
    });

    applyButton.addEventListener('click', () => {
      formMessage.classList.remove('error');
      const startTime = startTimeInput.value.trim();
      if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(startTime)) {
        formMessage.textContent = 'Začetek mora biti HH:MM (24-urno).';
        formMessage.classList.add('error');
        return;
      }
      const durationMinutes = Number(durationInput.value);
      if (!Number.isFinite(durationMinutes) || durationMinutes <= 0) {
        formMessage.textContent = 'Trajanje mora biti pozitivno število minut.';
        formMessage.classList.add('error');
        return;
      }
      // Built from the form state ONLY, so an edit can never leave a stale
      // replay field behind (the server re-validates and re-packs anyway --
      // this is the honest client mirror of that).
      const entry = { id: select.value, startTime, durationMinutes };
      if (replayCheck.checked) {
        entry.type = 'replay';
        entry.sourceDate = sourceDateInput.value.trim();
        const sourceTimeKey = sourceTimeKeyInput.value.trim();
        if (sourceTimeKey) entry.sourceTimeKey = sourceTimeKey;
      }
      if (existing) {
        Object.assign(existing, entry);
        if (entry.type !== 'replay') delete existing.type;
        if (entry.sourceDate === undefined) delete existing.sourceDate;
        if (entry.sourceTimeKey === undefined) delete existing.sourceTimeKey;
      } else {
        working.push(entry);
      }
      formEl.hidden = true;
      formEl.replaceChildren();
      rerenderEntries();
    });
  };

  const rerenderEntries = () => {
    entriesEl.replaceChildren();
    const sorted = [...working].sort((a, b) => timeToMinutes(a.startTime) - timeToMinutes(b.startTime));
    if (sorted.length === 0) {
      const empty = document.createElement('p');
      empty.className = 'muted';
      empty.style.margin = '0';
      empty.textContent = 'Prazno — shranjeno kot prazen dan (samo filler).';
      entriesEl.appendChild(empty);
    }
    for (const occ of sorted) {
      entriesEl.appendChild(
        makeDateEntryRow(occ, {
          onEdit: () => openEntryForm(occ),
          onRemove: () => {
            const idx = working.indexOf(occ);
            if (idx !== -1) working.splice(idx, 1);
            rerenderEntries();
          },
        })
      );
    }
    const addEntryButton = document.createElement('button');
    addEntryButton.type = 'button';
    addEntryButton.className = 'btn btn-small';
    addEntryButton.textContent = '+ Dodaj vnos';
    addEntryButton.addEventListener('click', () => openEntryForm(null));
    entriesEl.appendChild(addEntryButton);
  };

  rerenderEntries();

  saveButton.addEventListener('click', async () => {
    messageEl.textContent = 'Shranjujem...';
    messageEl.classList.remove('error');
    try {
      await api(`/api/schedule/dates/${date}`, {
        method: 'PUT',
        body: { occurrences: working },
      });
      closePopover();
      await render();
    } catch (err) {
      messageEl.textContent = err.message;
      messageEl.classList.add('error');
    }
  });

  openPopoverAt(clientX, clientY, { title, body }, 330);
}

let renderSeq = 0; // last-completed-wins: a visit-reload racing a drag-triggered render

async function render() {
  closePopover();
  const mine = ++renderSeq;
  try {
    const [{ schedule }, , { readiness }, { dates }] = await Promise.all([
      api('/api/schedule'),
      loadShowTitles(),
      api('/api/schedule/readiness'),
      api('/api/schedule/dates'),
    ]);
    // A newer render completed while this one was asking -- its grid is the
    // truth; repainting from this older answer would rewind the view.
    if (mine !== renderSeq) return;
    currentSchedule = schedule;
    currentReadiness = readiness;
    currentDates = dates ?? {};
    gridEl.innerHTML = '';
    gridEl.style.gridTemplateRows = `auto ${DAY_HEIGHT}px`;

    const today = todayWeekday();
    // Which weekday columns carry a REAL date override within the next 7
    // days (informational chip only -- the grid itself stays a template view
    // by design; the Datumi list below is the override truth).
    const overriddenWeekdays = new Set();
    {
      const cursor = new Date();
      for (let i = 0; i < 7; i++) {
        if (currentDates[dateKeyOf(cursor)] !== undefined) {
          overriddenWeekdays.add(WEEKDAYS[(cursor.getDay() + 6) % 7]);
        }
        cursor.setDate(cursor.getDate() + 1);
      }
    }
    gridEl.appendChild(makeHeaderCell(''));
    for (const day of WEEKDAYS) {
      gridEl.appendChild(makeHeaderCell(DAY_LABELS[day], day === today, day, overriddenWeekdays.has(day)));
    }

    const hourCol = document.createElement('div');
    hourCol.style.position = 'relative';
    hourCol.style.height = `${DAY_HEIGHT}px`;
    hourCol.style.background = 'var(--surface)';
    for (let h = 0; h < 24; h++) {
      const label = document.createElement('div');
      label.className = 'schedule-hour-label';
      label.style.position = 'absolute';
      label.style.top = `${h * 60 * PX_PER_MIN - 6}px`;
      label.style.right = '0';
      label.textContent = `${String(h).padStart(2, '0')}:00`;
      hourCol.appendChild(label);
    }
    gridEl.appendChild(hourCol);

    for (const day of WEEKDAYS) {
      const col = document.createElement('div');
      col.className = day === today ? 'schedule-day-column is-today' : 'schedule-day-column';
      col.dataset.day = day;
      col.style.height = `${DAY_HEIGHT}px`;
      col.addEventListener('click', (event) => {
        if (event.target !== col) return;
        const rect = col.getBoundingClientRect();
        const minutes = (event.clientY - rect.top) / PX_PER_MIN;
        const startTime = minutesToTime(Math.round(minutes / DRAG_SNAP_MIN) * DRAG_SNAP_MIN);
        openAddPopover(day, startTime, event.clientX, event.clientY);
      });
      for (const occ of currentSchedule[day] ?? []) {
        col.appendChild(makeBlock(day, occ));
      }
      gridEl.appendChild(col);
    }

    updateNowLine();
    renderDates();

    // Default the visible scroll position to just above "now" (with an hour
    // of already-aired context still visible above it) rather than the top of
    // the grid, so opening the page answers "what's on right now" without any
    // scrolling -- only on the view's first render, so it doesn't fight a
    // studio user who's scrolled elsewhere on a later refresh.
    if (!hasScrolledToDay) {
      hasScrolledToDay = true;
      scrollEl.scrollTop = Math.max(0, (nowMinutes() - 60) * PX_PER_MIN);
    }
  } catch (err) {
    // A failed grid load surfaces as a toast, not a silently stale grid --
    // same pattern as the drag/resize handlers above (render() is also
    // awaited from those, so it must never reject).
    showToast(err.message);
  }
}

window.addEventListener('hashchange', closePopover);

// "Dodaj datumski prenos": opens the same per-date popover with an empty
// working copy -- nothing is written until SAVE, so exploring a date can
// never create a dark day by accident. An existing date just opens its
// editor (the toast says so; the operator then sees what's already stored).
dateAddButton.addEventListener('click', () => {
  const date = dateNewInput.value.trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    showToast('Datum mora biti v obliki YYYY-MM-DD (npr. 2026-12-25).');
    return;
  }
  if (currentDates[date]) showToast('Ta datum že ima prenos — odpiram urejanje.');
  const rect = dateAddButton.getBoundingClientRect();
  openDatePopover(date, rect.left, rect.bottom + 6);
  dateNewInput.value = '';
});

let nowLineTimer = null;

export function startScheduleView() {
  render();
  // Guarded like onAir.js's pollTimer -- startScheduleView() re-runs on
  // every visit to the tab (see app.js), but the line only needs one ticker
  // for the process's whole lifetime.
  if (!nowLineTimer) {
    nowLineTimer = setInterval(updateNowLine, 30000);
  }
}
