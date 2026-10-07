/**
 * core/event-actions.js - everything you can do to an event from the events list and from the overview tab:
 * copy links, QR code, status changes, export, duplicate / create / import, delete.
 *
 * Every helper takes a `ctx` (global or event scoped, see app.js) and only uses: api, toast, confirm, navigate,
 * listEvents(), refreshEvents(). Helpers never re-render anything themselves: the caller refreshes its own view.
 */
import { el, icon, slugify, copyToClipboard, downloadBlob, uid, formatBytes } from '../../shared/js/dom.js';
import { openModal, withBusy } from '../../shared/js/ui.js';
import { qrCode, qrSvg } from '../../shared/js/qr.js';
import { config, eventUrl, scoreboardUrl } from '../../shared/js/config.js';
import { STATUS, brandSwatch, slugProblem, freeSlug, errorText, fileStem, needsQuestions, fmt, fill } from './util.js';

const MAX_BUNDLE_BYTES = 10 * 1024 * 1024;

// ---------------------------------------------------------------------------------------------
// links
// ---------------------------------------------------------------------------------------------
export function publicLinks(event) {
  return { game: eventUrl(event.slug), scoreboard: scoreboardUrl(event.slug) };
}

/** Copy a URL and tell the user. @returns {Promise<boolean>} */
export async function copyLink(ctx, url, what = 'Link') {
  const ok = await copyToClipboard(url);
  if (ok) ctx.toast(`${what} copied to the clipboard`, { type: 'success', duration: 2500 });
  else ctx.toast('Could not copy automatically. Select the link and copy it manually.', { type: 'warning' });
  return ok;
}

// ---------------------------------------------------------------------------------------------
// status
// ---------------------------------------------------------------------------------------------
/**
 * Change an event's status. Closing asks for confirmation; going live with too few questions warns first
 * (both skipped with `{confirm:false}`, used by the Undo action).
 * @returns {Promise<object|null>} the updated EventAdmin, or null when cancelled / failed
 */
export async function changeStatus(ctx, event, next, { confirm = true } = {}) {
  if (!event || event.status === next) return event || null;
  const prev = event.status;

  if (next === 'closed' && confirm) {
    const ok = await ctx.confirm({
      title: `Close "${event.name}"?`,
      message: ['Players will no longer be able to register or play, and the event disappears from the hub.', 'The scoreboard stays viewable and you can reopen the event at any time.'],
      confirmLabel: 'Close event', danger: true, icon: 'flag-checkered',
    });
    if (!ok) return null;
  }
  if (next === 'live' && confirm && needsQuestions(event)) {
    const need = event.settings.questions_per_game, have = event.counts.active_questions;
    const ok = await ctx.confirm({
      title: 'Not enough active questions',
      message: `Each game needs ${need} questions but only ${fmt(have)} ${have === 1 ? 'is' : 'are'} active. Players would get an error when they start a game.`,
      confirmLabel: 'Go live anyway', icon: 'warning',
    });
    if (!ok) return null;
  }

  try {
    const updated = await ctx.api.put(`/admin/events/${event.id}`, { status: next });
    const verb = { live: 'is now live', draft: 'is back to draft', closed: 'is closed' }[next];
    ctx.toast(`${event.name} ${verb}`, {
      type: 'success',
      action: { label: 'Undo', onClick: () => { changeStatus(ctx, updated, prev, { confirm: false }).then((u) => u && ctx.refreshEvents().catch(() => {})); } },
    });
    return updated;
  } catch (e) {
    ctx.toast(errorText(e, 'Could not change the status.'), { type: 'error' });
    return null;
  }
}

/** The three transitions offered from a given status, for menus. */
export function statusTransitions(status) {
  return ['live', 'draft', 'closed'].map((s) => ({ status: s, ...STATUS[s], current: s === status }));
}

// ---------------------------------------------------------------------------------------------
// export
// ---------------------------------------------------------------------------------------------
export async function exportEvent(ctx, event) {
  try {
    const name = await ctx.api.download(`/admin/events/${event.id}/export`, { filename: `${fileStem(event.slug)}.json` });
    ctx.toast(`Bundle saved as ${name}`, { type: 'success' });
    return true;
  } catch (e) {
    ctx.toast(errorText(e, 'Export failed.'), { type: 'error' });
    return false;
  }
}

// ---------------------------------------------------------------------------------------------
// delete
// ---------------------------------------------------------------------------------------------
export async function deleteEvent(ctx, event) {
  const c = event.counts || {};
  const plural = (n, one, many) => `${fmt(n || 0)} ${n === 1 ? one : many}`;
  const lost = [
    plural(c.questions, 'question', 'questions'), plural(c.categories, 'category', 'categories'),
    plural(c.players, 'player', 'players'), plural(c.games_completed, 'completed game', 'completed games'),
  ].map((text) => el('li', null, text));
  const backupBtn = el('button', { type: 'button', class: 'btn btn--secondary btn--sm', on: { click: (e) => withBusy(e.currentTarget, () => exportEvent(ctx, event)) } }, icon('download-simple'), 'Download a backup bundle first');
  const details = el('div', { class: 'delete-impact' },
    el('p', { class: 'delete-impact__title' }, 'Everything below is deleted for good:'),
    el('ul', { class: 'delete-impact__list' }, ...lost, el('li', null, 'The public pages and scoreboard of ', el('code', null, event.slug))),
    el('p', { class: 'u-muted u-text-sm' }, 'The bundle contains the event, categories and questions. Players and results are not part of it.'),
    backupBtn);
  const ok = await ctx.confirm({
    title: `Delete "${event.name}"?`,
    message: 'This permanently removes the event and everything that belongs to it.',
    details, confirmLabel: 'Delete event', danger: true, requireText: event.slug, requireLabel: `Type the slug ${event.slug} to confirm`,
  });
  if (!ok) return false;
  try {
    await ctx.api.delete(`/admin/events/${event.id}`, { query: { confirm: event.slug } });
    ctx.toast(`Deleted ${event.name}`, { type: 'success' });
    return true;
  } catch (e) {
    ctx.toast(errorText(e, 'Could not delete the event.'), { type: 'error' });
    return false;
  }
}

// ---------------------------------------------------------------------------------------------
// QR dialog
// ---------------------------------------------------------------------------------------------
async function svgToPng(svgText, px) {
  const img = new Image();
  await new Promise((resolve, reject) => {
    img.onload = resolve;
    img.onerror = () => reject(new Error('Could not render the QR code'));
    img.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svgText)}`;   // data: (not blob:) so the CSP img-src allows it
  });
  const canvas = el('canvas', { width: px, height: px });
  const g = canvas.getContext('2d');
  g.fillStyle = '#ffffff';
  g.fillRect(0, 0, px, px);
  g.imageSmoothingEnabled = false;
  g.drawImage(img, 0, 0, px, px);
  return new Promise((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('PNG export failed'))), 'image/png'));
}

/** QR code dialog for the game or scoreboard link. @param {'game'|'scoreboard'} [kind] */
export function openQrDialog(ctx, event, kind = 'game') {
  const state = { kind, lang: '' };
  const multi = (event.languages || []).length > 1;
  const urlOf = () => (state.kind === 'scoreboard' ? scoreboardUrl(event.slug) : eventUrl(event.slug, state.lang ? { lang: state.lang } : {}));

  const qrHost = el('div', { class: 'qr-dialog__qr' });
  const urlText = el('code', { class: 'qr-card__url' });
  const caption = el('p', { class: 'qr-card__caption' });
  const paint = () => {
    const url = urlOf();
    qrHost.replaceChildren(qrCode(url, { large: true, ecc: 'M', label: `QR code for ${url}` }));
    urlText.textContent = url;
    caption.textContent = state.kind === 'scoreboard' ? 'Scan to follow the live scoreboard on a phone.' : 'Scan to join the game on a phone.';
    langField.hidden = !(multi && state.kind === 'game');
  };

  const seg = el('div', { class: 'segmented segmented--block', role: 'radiogroup', 'aria-label': 'Which link' },
    ...[['game', 'Game', 'device-mobile'], ['scoreboard', 'Scoreboard', 'television']].map(([value, label, ic]) => {
      const input = el('input', { type: 'radio', name: 'qr-kind', value, checked: state.kind === value, on: { change: () => { state.kind = value; paint(); } } });
      return el('label', null, input, el('span', null, icon(ic), label));
    }));

  const langId = uid('qr-lang');
  const langSel = el('select', { class: 'select', id: langId, on: { change: (e) => { state.lang = e.target.value; paint(); } } },
    el('option', { value: '' }, 'Player\'s own language'),
    ...(event.languages || []).map((l) => el('option', { value: l }, { en: 'English', fr: 'Français' }[l] || l)));
  const langField = el('div', { class: 'field' }, el('label', { class: 'field__label', for: langId }, 'Language'), langSel);

  const download = (type) => async (e) => {
    const btn = e.currentTarget;
    await withBusy(btn, async () => {
      try {
        const url = urlOf();
        const stem = `${fileStem(event.slug)}-${state.kind}-qr`;
        const svg = qrSvg(url, { margin: 4, ecc: 'M', label: `QR code for ${url}` });
        if (type === 'svg') {
          const text = `<?xml version="1.0" encoding="UTF-8"?>\n${new XMLSerializer().serializeToString(svg)}`;
          downloadBlob(text, `${stem}.svg`, 'image/svg+xml');
        } else {
          svg.setAttribute('width', '1024'); svg.setAttribute('height', '1024');
          downloadBlob(await svgToPng(new XMLSerializer().serializeToString(svg), 1024), `${stem}.png`, 'image/png');
        }
        ctx.toast(`QR code saved as ${stem}.${type}`, { type: 'success', duration: 2500 });
      } catch (err) {
        ctx.toast(errorText(err, 'Could not save the QR code.'), { type: 'error' });
      }
    });
  };

  const draftNote = event.status !== 'live'
    ? el('div', { class: 'alert alert--warning' }, icon('warning-fill', { class: 'alert__icon' }),
      el('div', null, el('p', { class: 'alert__title' }, event.status === 'draft' ? 'This event is a draft' : 'This event is closed'),
        el('p', { class: 'alert__text' }, event.status === 'draft' ? 'Players cannot open the link until you set the event live.' : 'The game is not playable. The scoreboard link still works.')))
    : null;

  const content = el('div', { class: 'qr-dialog stack' },
    seg, langField, draftNote,
    el('div', { class: 'qr-card' }, qrHost, caption, urlText),
    el('div', { class: 'qr-dialog__actions' },
      el('button', { type: 'button', class: 'btn btn--secondary btn--sm', on: { click: () => copyLink(ctx, urlOf()) } }, icon('copy'), 'Copy link'),
      el('button', { type: 'button', class: 'btn btn--secondary btn--sm', on: { click: download('svg') } }, icon('download-simple'), 'SVG'),
      el('button', { type: 'button', class: 'btn btn--secondary btn--sm', on: { click: download('png') } }, icon('download-simple'), 'PNG'),
      el('a', { class: 'btn btn--ghost btn--sm', href: urlOf(), target: '_blank', rel: 'noopener', on: { click: (e) => { e.currentTarget.href = urlOf(); } } }, icon('arrow-square-out'), 'Open')));
  paint();
  return openModal({ title: 'Share this event', description: `${event.game_title} · ${event.name}`, icon: 'qr-code', size: 'md', content, actions: [{ label: 'Done', variant: 'primary' }] });
}

// ---------------------------------------------------------------------------------------------
// New event / duplicate / import dialog
// ---------------------------------------------------------------------------------------------
const MODE_META = {
  blank: { label: 'Blank', icon: 'sparkle', submit: 'Create event', title: 'New event' },
  duplicate: { label: 'Duplicate', icon: 'copy', submit: 'Duplicate event', title: 'Duplicate event' },
  import: { label: 'Import', icon: 'file-arrow-up', submit: 'Import event', title: 'Import an event bundle' },
};

function validateBundle(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return 'This file does not contain a JSON object.';
  if (data.format !== 'gravitee-quiz-event') return 'Not an event bundle: the "format" field must be "gravitee-quiz-event".';
  if (data.version !== 1) return `Unsupported bundle version ${JSON.stringify(data.version)} (this console reads version 1).`;
  if (!data.event || typeof data.event !== 'object') return 'The bundle has no "event" section.';
  if (!data.event.name || !data.event.slug) return 'The bundle event needs a name and a slug.';
  return null;
}

/**
 * The "New event" flow (Blank / Duplicate / Import) and, with `lockMode`, the stand-alone "Duplicate" dialog.
 * On success it refreshes the shell's event list and jumps to the new event's Settings tab.
 * @param {object} ctx
 * @param {{mode?:'blank'|'duplicate'|'import', source?:object, lockMode?:boolean, file?:File}} [opts]
 * @returns {Promise<object|undefined>} the created event
 */
export async function openNewEventDialog(ctx, { mode = 'blank', source = null, lockMode = false } = {}) {
  let events = [];
  try { events = await ctx.listEvents(); } catch { /* the slug hint is best effort */ }
  const S = {
    mode, sourceId: source?.id ?? events[0]?.id ?? null, slugTouched: false,
    copyBranding: true, copySettings: true, copyQuestions: true, bundle: null, fileName: '',
  };
  const src = () => events.find((e) => e.id === S.sourceId) || null;
  const ids = { name: uid('ne-name'), title: uid('ne-title'), slug: uid('ne-slug'), slugHelp: uid('ne-slug-help'), source: uid('ne-source') };

  // ---- fields -----------------------------------------------------------------------------
  const name = el('input', { class: 'input', id: ids.name, type: 'text', maxlength: 200, autocomplete: 'off', required: true, placeholder: 'World AI Summit 2027' });
  const title = el('input', { class: 'input', id: ids.title, type: 'text', maxlength: 100, autocomplete: 'off', placeholder: 'AI Masters' });
  const slug = el('input', { class: 'input input--mono', id: ids.slug, type: 'text', maxlength: 48, autocomplete: 'off', autocapitalize: 'off', spellcheck: 'false', placeholder: 'world-ai-summit-2027', 'aria-describedby': ids.slugHelp });
  const slugHelp = el('p', { class: 'field__help', id: ids.slugHelp, 'aria-live': 'polite' });
  const field = (id, label, input, extra, opts = {}) => el('div', { class: ['field', opts.full && 'field--full'], dataset: { field: opts.key } },
    el('label', { class: 'field__label', for: id }, label, opts.optional ? el('span', { class: 'field__optional' }, 'optional') : null), input, extra || null,
    el('p', { class: 'field__error', hidden: true, role: 'alert' }));
  const nameField = field(ids.name, 'Event name', name, el('p', { class: 'field__help' }, 'Shown in the hub and in this console.'), { key: 'name' });
  const titleField = field(ids.title, 'Game title', title, el('p', { class: 'field__help' }, 'The brand players see, for example "API Masters".'), { key: 'game_title' });
  const slugField = field(ids.slug, 'URL slug', slug, slugHelp, { key: 'slug' });

  const alertBox = el('div', { class: 'alert alert--danger', role: 'alert', hidden: true });
  const showAlert = (lines) => {
    const list = (Array.isArray(lines) ? lines : [lines]).filter(Boolean);
    alertBox.replaceChildren(icon('warning-fill', { class: 'alert__icon' }),
      el('div', null, el('p', { class: 'alert__title' }, list.length > 1 ? 'Please fix the following' : list[0]), list.length > 1 ? el('ul', { class: 'alert__list' }, ...list.map((l) => el('li', null, l))) : null));
    alertBox.hidden = !list.length;
  };
  const fieldError = (key, message) => {
    const f = content.querySelector(`[data-field="${key}"]`);
    if (!f) return false;
    const err = f.querySelector('.field__error');
    err.textContent = message || ''; err.hidden = !message;
    f.classList.toggle('field--invalid', !!message);
    f.querySelector('input,select')?.setAttribute('aria-invalid', message ? 'true' : 'false');
    return true;
  };
  const clearErrors = () => { showAlert([]); content.querySelectorAll('[data-field]').forEach((f) => fieldError(f.dataset.field, '')); };

  // ---- mode switch ------------------------------------------------------------------------
  const modeInputs = {};
  const radioName = uid('ne-mode');
  const modeSwitch = el('div', { class: 'segmented segmented--block', role: 'radiogroup', 'aria-label': 'How do you want to start?' },
    ...Object.entries(MODE_META).map(([value, m]) => {
      const input = el('input', { type: 'radio', name: radioName, value, checked: S.mode === value, on: { change: () => setMode(value) } });
      modeInputs[value] = input;
      return el('label', null, input, el('span', null, icon(m.icon), m.label));
    }));

  // ---- panels -----------------------------------------------------------------------------
  const blankPanel = el('p', { class: 'u-muted u-text-sm' }, 'Start from scratch with the Gravitee defaults. You will set the dates, languages, rules and branding next.');

  const sourceSel = el('select', { class: 'select', id: ids.source, on: { change: (e) => { S.sourceId = Number(e.target.value); onSourceChanged(); } } },
    ...events.map((e) => el('option', { value: e.id, selected: e.id === S.sourceId }, `${e.game_title} · ${e.name}`)));
  const copyOpt = (key, label, hint) => el('label', { class: 'check' },
    el('input', { type: 'checkbox', class: 'checkbox', checked: S[key], on: { change: (e) => { S[key] = e.target.checked; } } }),
    el('span', { class: 'check__text' }, label, el('span', { class: 'check__hint' }, hint)));
  const dupPanel = el('div', { class: 'stack' },
    lockMode ? el('p', { class: 'dup-source' }, icon('copy'), el('span', null, 'Copying from ', el('strong', null, source?.name || ''), el('span', { class: 'u-muted' }, ` · ${source?.game_title || ''}`)))
      : el('div', { class: 'field' }, el('label', { class: 'field__label', for: ids.source }, 'Copy from'), sourceSel),
    el('fieldset', { class: 'fieldset fieldset--tight' },
      el('legend', null, 'What to copy'),
      copyOpt('copyBranding', 'Branding', 'Colours, logo, background and default theme'),
      copyOpt('copySettings', 'Game rules', 'Questions per game, timer, scoring, ordering, registration fields'),
      copyOpt('copyQuestions', 'Categories and questions', 'The whole question pool'),
      el('p', { class: 'field__help' }, 'Players, games and results are never copied. The copy starts as a draft.')));

  const fileInput = el('input', { type: 'file', class: 'u-sr-only', accept: '.json,application/json', id: uid('ne-file'), on: { change: () => { const f = fileInput.files?.[0]; if (f) loadFile(f); } } });
  const dzText = el('span', { class: 'dropzone__text' });
  const dropzone = el('label', { class: 'dropzone dropzone--file', for: fileInput.id },
    icon('file-arrow-up', { size: '2rem' }), dzText, fileInput);
  const bundleSummary = el('div', { class: 'bundle-summary', hidden: true });
  const importPanel = el('div', { class: 'stack' }, dropzone, bundleSummary,
    el('p', { class: 'field__help' }, 'Choose a JSON bundle exported from this console (event, categories and questions). It is imported as a draft.'));
  ['dragenter', 'dragover'].forEach((t) => dropzone.addEventListener(t, (e) => { e.preventDefault(); dropzone.classList.add('is-over'); }));
  ['dragleave', 'drop'].forEach((t) => dropzone.addEventListener(t, (e) => { e.preventDefault(); dropzone.classList.remove('is-over'); }));
  dropzone.addEventListener('drop', (e) => { const f = e.dataTransfer?.files?.[0]; if (f) loadFile(f); });
  const paintDz = () => { dzText.replaceChildren(S.fileName ? el('span', null, el('strong', null, S.fileName), ' · choose another file') : el('span', null, el('strong', null, 'Choose a bundle file'), ' or drop it here')); };
  paintDz();

  async function loadFile(file) {
    clearErrors();
    S.bundle = null; S.fileName = file.name; paintDz(); bundleSummary.hidden = true;
    try {
      if (file.size > MAX_BUNDLE_BYTES) throw new Error(`The file is ${formatBytes(file.size)}; the limit is 10 MB.`);
      let data;
      try { data = JSON.parse(await file.text()); } catch { throw new Error('This file is not valid JSON.'); }
      const bad = validateBundle(data);
      if (bad) throw new Error(bad);
      S.bundle = data;
      const ev = data.event;
      bundleSummary.replaceChildren(
        el('div', { class: 'bundle-summary__head' }, brandSwatch(ev.branding), el('div', null, el('strong', null, ev.name), el('div', { class: 'u-muted u-text-sm' }, `${ev.game_title || 'Quiz'} · ${ev.slug}`))),
        el('div', { class: 'chips' },
          el('span', { class: 'badge' }, `${fmt((data.questions || []).length)} question${(data.questions || []).length === 1 ? '' : 's'}`),
          el('span', { class: 'badge' }, `${fmt((data.categories || []).length)} categor${(data.categories || []).length === 1 ? 'y' : 'ies'}`),
          el('span', { class: 'badge' }, (ev.languages || []).map((l) => String(l).toUpperCase()).join(' · ') || 'EN')));
      bundleSummary.hidden = false;
      if (!S.nameTouched) { name.value = ev.name; }
      if (!S.slugTouched) { slug.value = freeSlug(ev.slug, events); }
      refreshSlugHelp();
    } catch (err) {
      S.fileName = ''; paintDz();
      showAlert(err.message);
    }
  }

  // ---- slug helper ------------------------------------------------------------------------
  function refreshSlugHelp() {
    const v = slug.value.trim();
    const problem = v ? slugProblem(v, events) : null;
    slugHelp.className = `field__help${problem ? ' field__help--bad' : v ? ' field__help--ok' : ''}`;
    fill(slugHelp,
      v ? icon(problem ? 'warning-circle' : 'check-circle', { size: 'sm' }) : null,
      v ? ` ${problem || 'Available.'} ` : 'Letters, digits and hyphens. ',
      v && !problem ? el('span', { class: 'u-muted' }, `${config.publicBaseUrl.replace(/^https?:\/\//, '')}/${v}`) : null);
  }
  name.addEventListener('input', () => {
    S.nameTouched = true;
    if (!S.slugTouched) { const base = slugify(name.value); slug.value = base ? freeSlug(base, events) : ''; refreshSlugHelp(); }
  });
  slug.addEventListener('input', () => { S.slugTouched = true; slug.value = slug.value.toLowerCase().replace(/\s+/g, '-'); refreshSlugHelp(); fieldError('slug', ''); });

  function onSourceChanged() {
    const s = src();
    if (!s) return;
    if (!S.nameTouched) { name.value = `${s.name} (copy)`; }
    if (!S.slugTouched) { slug.value = freeSlug(slugify(name.value), events); }
    title.placeholder = s.game_title;
    refreshSlugHelp();
  }

  // ---- layout -----------------------------------------------------------------------------
  const panels = { blank: blankPanel, duplicate: dupPanel, import: importPanel };
  const panelHost = el('div', { class: 'ne-panel' });
  const content = el('form', { class: 'stack ne-form', novalidate: true, on: { submit: (e) => { e.preventDefault(); submit(); } } },
    lockMode ? null : modeSwitch, alertBox, panelHost, el('div', { class: 'form-grid' }, nameField, titleField, slugField));
  content.addEventListener('keydown', (e) => { if (e.key === 'Enter' && e.target.matches('input:not([type=file]):not([type=checkbox]):not([type=radio])')) { e.preventDefault(); submit(); } });
  slugField.classList.add('field--full');
  nameField.classList.add('field--full');

  let modal = null;
  function setMode(next) {
    S.mode = next;
    clearErrors();
    panelHost.replaceChildren(panels[next]);
    titleField.hidden = next === 'import';
    titleField.querySelector('.field__label').replaceChildren('Game title', el('span', { class: 'field__optional', hidden: next !== 'duplicate' }, 'optional'));
    if (modeInputs[next]) modeInputs[next].checked = true;
    if (next === 'duplicate') onSourceChanged();
    if (modal) {
      const btn = modal.dialog.querySelector('.dialog__footer .btn--primary');
      btn.textContent = MODE_META[next].submit;
    }
    refreshSlugHelp();
  }

  // ---- submit -----------------------------------------------------------------------------
  async function submit() {
    clearErrors();
    const n = name.value.trim(), t = title.value.trim(), s = slug.value.trim();
    let bad = false;
    if (!n) { fieldError('name', 'Give the event a name.'); bad = true; }
    if (S.mode === 'blank' && !t) { fieldError('game_title', 'Give the game a title.'); bad = true; }
    const sp = slugProblem(s, events);
    if (sp) { fieldError('slug', sp); bad = true; }
    if (S.mode === 'duplicate' && !src()) { showAlert('Choose the event to copy.'); bad = true; }
    if (S.mode === 'import' && !S.bundle) { showAlert('Choose a bundle file first.'); bad = true; }
    if (bad) { content.querySelector('.field--invalid input, .alert:not([hidden])')?.focus?.(); return; }

    const btn = modal.dialog.querySelector('.dialog__footer .btn--primary');
    await withBusy(btn, async () => {
      try {
        let created;
        if (S.mode === 'blank') created = await ctx.api.post('/admin/events', { slug: s, name: n, game_title: t });
        else if (S.mode === 'duplicate') {
          created = await ctx.api.post(`/admin/events/${S.sourceId}/duplicate`, {
            slug: s, name: n, ...(t ? { game_title: t } : {}),
            copy_branding: S.copyBranding, copy_settings: S.copySettings, copy_questions: S.copyQuestions,
          });
        } else created = await ctx.api.post('/admin/events/import', { bundle: S.bundle, slug: s, name: n, status: 'draft' });
        await ctx.refreshEvents().catch(() => {});
        // a copy still carries the source's headline, description, location and colours: say where to review them
        ctx.toast(`${created.name} created${S.mode === 'blank' ? '. Set it up below.' : S.mode === 'duplicate' ? '. Review its texts and dates under Appearance.' : ''}`, { type: 'success' });
        modal.close(created);
        ctx.navigate(`#/events/${created.id}/settings`);
      } catch (e) {
        if (e.isConflict) {
          fieldError('slug', e.detail || 'This slug is already used.');
          slug.value = freeSlug(s, [...events, { slug: s }]); S.slugTouched = true; refreshSlugHelp();
          slug.focus(); slug.select();
          return;
        }
        const lines = [];
        const target = (k) => {
          const key = k.split('.').pop();
          if (key === 'slug' || key === 'name') return key;
          return key === 'game_title' && S.mode !== 'import' ? key : null;
        };
        for (const [k, msg] of Object.entries(e.fieldErrors || {})) {
          const t = target(k);
          if (!(t && fieldError(t, msg))) lines.push(`${k.replace(/^bundle\./, '')}: ${msg}`);
        }
        if (!Object.keys(e.fieldErrors || {}).length) lines.push(...errorText(e, 'Could not create the event.').split('; '));
        showAlert(lines);
        alertBox.hidden || alertBox.scrollIntoView({ block: 'nearest' });
      }
    });
  }

  const meta = MODE_META[S.mode];
  modal = openModal({
    title: lockMode ? meta.title : 'New event',
    description: lockMode ? 'Copies branding, rules, categories and questions. Never players or results.' : 'Start blank, copy an existing event, or import a bundle.',
    icon: lockMode ? 'copy' : 'plus', size: 'md', content,
    actions: [
      { label: 'Cancel', variant: 'secondary' },
      { label: meta.submit, variant: 'primary', closes: false, onClick: () => submit() },
    ],
  });
  setMode(S.mode);
  if (S.mode === 'duplicate' && lockMode) { name.value = `${source.name} (copy)`; slug.value = freeSlug(slugify(name.value), events); refreshSlugHelp(); title.placeholder = source.game_title; }
  else if (S.mode === 'duplicate') onSourceChanged();
  name.focus();
  name.select();
  const created = await modal.closed;
  return created && typeof created === 'object' ? created : undefined;
}

/** Stand-alone duplicate dialog for one event. */
export function openDuplicateDialog(ctx, event) {
  return openNewEventDialog(ctx, { mode: 'duplicate', source: event, lockMode: true });
}
