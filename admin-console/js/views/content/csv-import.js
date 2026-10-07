/**
 * CSV import wizard: choose a file -> dry-run preview (counts + per-row errors) -> confirm -> summary.
 *
 *   await openCsvImport(ctx, { onImported(result), restoreFocus })
 *
 * The server is the source of truth (POST .../questions/import-csv, ?dry_run=true first); the file is also parsed in the
 * browser so the preview table can show the rows next to the server's per-row errors.
 */
import { el, icon, formatBytes, downloadBlob, formatNumber } from '../../../shared/js/dom.js';
import { announce } from '../../../shared/js/ui.js';
import { describeError, openPanel, plural } from './common.js';

const MAX_BYTES = 5 * 1024 * 1024;
const KNOWN = ['category', 'difficulty', 'question_text_en', 'question_text_fr', 'correct_answer', 'green_label_en', 'green_label_fr', 'red_label_en', 'red_label_fr', 'explanation_en', 'explanation_fr', 'question_format', 'is_active'];
const PREVIEW_LIMIT = 300;

export const TEMPLATE_CSV = [
  KNOWN.join(','),
  'REST API,1,HTTP status code 201 means a resource was created.,Le code HTTP 201 indique qu’une ressource a été créée.,green,TRUE,Vrai,FALSE,Faux,201 Created answers a successful POST.,201 Created répond à un POST réussi.,true_false,true',
  'API Gateway,2,Which one is an open-source API gateway?,Lequel est une passerelle API open source ?,green,Gravitee,Gravitee,A fax machine,Un fax,Gravitee is open source.,Gravitee est open source.,two_choices,true',
].join('\r\n');

// ---------------------------------------------------------------------------------------------
// RFC 4180 style parser that numbers records exactly like the backend (header = row 1, blank lines count)
// ---------------------------------------------------------------------------------------------
const norm = (h) => String(h || '').replace(/^﻿/, '').trim().toLowerCase().replace(/[\s-]+/g, '_');

export function detectDelimiter(text) {
  const first = text.replace(/^﻿/, '').split(/\r?\n/, 1)[0] || '';
  let best = ',';
  let bestScore = [-1, -1];
  for (const d of [',', ';', '\t']) {
    const cells = first.split(d).map(norm);
    const score = [cells.filter((c) => KNOWN.includes(c)).length, cells.length];
    if (score[0] > bestScore[0] || (score[0] === bestScore[0] && score[1] > bestScore[1])) { best = d; bestScore = score; }
  }
  return best;
}

export function parseCsv(text, delimiter = detectDelimiter(text)) {
  const src = text.replace(/^﻿/, '');
  const records = [];
  let row = [];
  let cell = '';
  let quoted = false;
  let started = false; // a cell has begun on this record
  const endCell = () => { row.push(cell); cell = ''; started = true; };
  const endRecord = () => {
    if (!started && !row.length && cell === '') records.push([]);
    else { endCell(); records.push(row); }
    row = []; started = false;
  };
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (quoted) {
      if (c === '"') { if (src[i + 1] === '"') { cell += '"'; i++; } else quoted = false; } else cell += c;
    } else if (c === '"' && cell === '') { quoted = true; started = true; }
    else if (c === delimiter) endCell();
    else if (c === '\n') endRecord();
    else if (c === '\r') { if (src[i + 1] === '\n') i++; endRecord(); }
    else { cell += c; started = true; }
  }
  if (started || cell !== '' || row.length) endRecord();
  return records;
}

/** Records -> {columns, rows: [{row, cells: {column: value}}]} (blank records skipped, numbering preserved). */
export function readRows(records) {
  let header = null;
  const rows = [];
  records.forEach((rec, idx) => {
    const rowNo = idx + 1;
    const blank = !rec.some((c) => String(c).trim());
    if (!header) { if (!blank) header = rec.map(norm); return; }
    if (blank) return;
    const cells = {};
    header.forEach((name, i) => { if (name && !(name in cells)) cells[name] = rec[i] ?? ''; });
    rows.push({ row: rowNo, cells });
  });
  return { columns: (header || []).filter(Boolean), rows };
}

// ---------------------------------------------------------------------------------------------
// wizard
// ---------------------------------------------------------------------------------------------
/**
 * @param {object} ctx
 * @param {{onImported?: (result: object) => void, restoreFocus?: () => HTMLElement|null}} [o]
 */
export function openCsvImport(ctx, { onImported, restoreFocus } = {}) {
  let file = null;
  let parsed = null;     // {columns, rows}
  let dry = null;        // server dry-run result
  let busy = false;
  let step = 'choose';   // 'choose' | 'preview' | 'done'
  let errorsOnly = false;
  let chooseError = '';
  let finalResult = null;
  let imported = false;

  const body = el('div', { class: 'ci' });
  const footer = el('div', { class: 'dialog__footer ci-footer' });
  const panel = openPanel({
    title: 'Import questions from CSV', description: 'Add many questions at once from a spreadsheet.', iconName: 'file-arrow-up', size: 'xl', className: 'ci-dialog',
    content: body, footer, restoreFocus,
    beforeClose: () => !busy,
  });

  const stepper = () => {
    const items = [['choose', 'Choose file'], ['preview', 'Review'], ['done', 'Done']];
    const idx = items.findIndex(([id]) => id === step);
    return el('ol', { class: 'ci-steps', 'aria-label': 'Import progress' }, ...items.map(([id, label], i) => el('li', { class: [i < idx && 'is-done', i === idx && 'is-current'], 'aria-current': i === idx ? 'step' : null }, el('span', { class: 'ci-steps__n' }, i < idx ? icon('check', { size: 'sm' }) : String(i + 1)), label)));
  };

  function setFooter(...buttons) { footer.replaceChildren(...buttons); }
  const btn = (label, { variant = 'secondary', iconName, onClick, disabled = false, loading = false, cls = '' } = {}) => {
    const b = el('button', { type: 'button', class: ['btn', `btn--${variant}`, loading && 'is-loading', cls], disabled }, iconName ? icon(iconName) : null, label);
    if (loading) b.setAttribute('aria-busy', 'true');
    if (onClick) b.addEventListener('click', onClick);
    return b;
  };

  // ---- step 1: choose -----------------------------------------------------------------------
  function renderChoose() {
    step = 'choose';
    const input = el('input', { type: 'file', accept: '.csv,text/csv,text/plain', class: 'u-sr-only', id: 'ci-file', 'aria-describedby': 'ci-file-help' });
    const zone = el('label', { class: 'dropzone ci-drop', for: 'ci-file' },
      el('span', { class: 'ci-drop__icon' }, icon('upload-simple', { size: 'xl' })),
      el('strong', null, 'Drop a CSV file here, or click to browse'),
      el('span', { id: 'ci-file-help', class: 'u-muted' }, 'UTF-8 CSV, up to 5 MB and 5000 rows. Comma, semicolon or tab separated.'));
    const pick = (f) => { if (f) handleFile(f); };
    input.addEventListener('change', () => pick(input.files?.[0]));
    for (const ev of ['dragenter', 'dragover']) zone.addEventListener(ev, (e) => { e.preventDefault(); zone.classList.add('is-over'); });
    for (const ev of ['dragleave', 'drop']) zone.addEventListener(ev, (e) => { e.preventDefault(); zone.classList.remove('is-over'); });
    zone.addEventListener('drop', (e) => pick(e.dataTransfer?.files?.[0]));
    input.addEventListener('focus', () => zone.classList.add('is-focus'));
    input.addEventListener('blur', () => zone.classList.remove('is-focus'));

    const errorBox = el('div', { class: 'alert alert--danger', role: 'alert', hidden: !chooseError },
      icon('warning-fill', { class: 'alert__icon' }), el('div', null, el('p', { class: 'alert__title' }, 'This file cannot be imported'), el('p', { class: 'alert__text' }, chooseError)));

    body.replaceChildren(
      stepper(), errorBox, input, zone,
      el('div', { class: 'ci-help' },
        el('div', { class: 'ci-help__col' },
          el('h3', { class: 'ci-help__title' }, 'Columns'),
          el('p', { class: 'u-muted' }, 'Required: ', el('code', null, 'question_text_en'), ', ', el('code', null, 'correct_answer'), ' (green or red). Optional: ', el('code', null, KNOWN.filter((k) => !['question_text_en', 'correct_answer'].includes(k)).join(', ')), '.')),
        el('div', { class: 'ci-help__col' },
          el('h3', { class: 'ci-help__title' }, 'Good to know'),
          el('ul', { class: 'ci-list' },
            el('li', null, 'Questions already in the pool (same English text) are skipped, so re-importing a fixed file is safe.'),
            el('li', null, 'Unknown categories are created for you.'),
            el('li', null, 'You see a full preview before anything is written.')))),
      el('div', null, el('button', { type: 'button', class: 'btn btn--secondary btn--sm', on: { click: () => downloadBlob(`﻿${TEMPLATE_CSV}\r\n`, 'questions-template.csv', 'text/csv;charset=utf-8') } }, icon('download-simple'), 'Download a template')));
    setFooter(btn('Cancel', { variant: 'ghost', onClick: () => panel.close(undefined) }));
    if (chooseError) announce(chooseError, { politeness: 'assertive' });
    input.focus({ preventScroll: true });
  }

  async function handleFile(f) {
    chooseError = '';
    if (!/\.(csv|txt)$/i.test(f.name) && !/csv|text/.test(f.type)) { chooseError = 'Choose a .csv file (in your spreadsheet: File > Download > CSV).'; renderChoose(); return; }
    if (f.size > MAX_BYTES) { chooseError = `The file is ${formatBytes(f.size)}; the limit is 5 MB.`; renderChoose(); return; }
    if (f.size === 0) { chooseError = 'The file is empty.'; renderChoose(); return; }
    file = f;
    busy = true;
    renderBusy('Checking your file…');
    try {
      const text = await f.text();
      parsed = readRows(parseCsv(text));
      dry = await ctx.api.upload(`/admin/events/${ctx.eventId}/questions/import-csv`, f, { query: { dry_run: true } });
      busy = false;
      errorsOnly = (dry.errors || []).length > 0; // the rows to fix first
      renderPreview();
    } catch (e) {
      busy = false;
      file = null; parsed = null; dry = null;
      chooseError = describeError(e);
      renderChoose();
    }
  }

  function renderBusy(message) {
    body.replaceChildren(stepper(), el('div', { class: 'ci-busy', role: 'status', 'aria-busy': 'true' }, el('span', { class: 'spinner' }), el('p', null, message)));
    setFooter(btn('Cancel', { variant: 'ghost', disabled: true }));
  }

  // ---- step 2: preview -------------------------------------------------------------------------
  function tile(label, value, tone, hint) {
    return el('div', { class: ['ci-tile', tone && `ci-tile--${tone}`] }, el('span', { class: 'ci-tile__value' }, formatNumber(value)), el('span', { class: 'ci-tile__label' }, label), hint ? el('span', { class: 'ci-tile__hint' }, hint) : null);
  }

  function renderPreview() {
    step = 'preview';
    const errors = dry.errors || [];
    const byRow = new Map(errors.map((e) => [e.row, e.message]));
    const created = dry.created || 0;
    const rowsAll = parsed?.rows || [];
    // rows that the server rejected but the client could not see (e.g. malformed record) still appear
    const known = new Set(rowsAll.map((r) => r.row));
    const orphan = errors.filter((e) => !known.has(e.row)).map((e) => ({ row: e.row, cells: {}, orphan: true }));
    const all = [...rowsAll, ...orphan].sort((a, b) => a.row - b.row);
    const visible = (errorsOnly ? all.filter((r) => byRow.has(r.row)) : all);
    const shown = visible.slice(0, PREVIEW_LIMIT);

    const tiles = el('div', { class: 'ci-tiles' },
      tile('New questions', created, created ? 'ok' : null, 'will be added'),
      tile('Duplicates', dry.skipped_duplicates || 0, null, 'already in the pool, skipped'),
      tile('New categories', dry.categories_created || 0, dry.categories_created ? 'info' : null, 'will be created'),
      tile('Rows with errors', errors.length, errors.length ? 'bad' : null, errors.length ? 'will be skipped' : 'all rows valid'));

    const banner = errors.length
      ? el('div', { class: 'alert alert--warning', role: 'status' }, icon('warning-fill', { class: 'alert__icon' }),
        el('div', null, el('p', { class: 'alert__title' }, `${plural(errors.length, 'row')} cannot be imported`),
          el('p', { class: 'alert__text' }, created ? `The ${plural(created, 'valid question')} will be imported; fix the others in your spreadsheet and import the file again later (duplicates are skipped, so nothing is added twice).` : 'Fix the rows below in your spreadsheet, then choose the file again.')))
      : (created
        ? el('div', { class: 'alert alert--success', role: 'status' }, icon('check-circle-fill', { class: 'alert__icon' }), el('div', null, el('p', { class: 'alert__title' }, 'Everything looks good'), el('p', { class: 'alert__text' }, `${plural(created, 'question')} ready to import.`)))
        : el('div', { class: 'alert', role: 'status' }, icon('info-fill', { class: 'alert__icon' }), el('div', null, el('p', { class: 'alert__title' }, 'Nothing new to import'), el('p', { class: 'alert__text' }, 'Every question in this file is already in the pool.'))));

    const filter = errors.length
      ? el('div', { class: 'segmented segmented--sm', role: 'radiogroup', 'aria-label': 'Rows to show' },
        ...[[false, `All rows (${all.length})`], [true, `Errors only (${errors.length})`]].map(([val, label]) => {
          const r = el('input', { type: 'radio', name: 'ci-filter', checked: errorsOnly === val });
          r.addEventListener('change', () => { errorsOnly = val; renderPreview(); });
          return el('label', null, r, el('span', null, label));
        }))
      : null;

    const rows = shown.map((r) => {
      const err = byRow.get(r.row);
      const c = r.cells;
      return el('tr', { class: err ? 'is-error' : null },
        el('td', { class: 'num', 'data-label': 'Row' }, String(r.row)),
        el('td', { 'data-label': 'Question', class: 'ci-q' }, c.question_text_en ? el('span', { class: 'ci-q__text' }, c.question_text_en) : el('span', { class: 'u-muted' }, '(no English text)')),
        el('td', { 'data-label': 'Category' }, c.category || el('span', { class: 'u-muted' }, '–')),
        el('td', { 'data-label': 'Level' }, c.difficulty || '1'),
        el('td', { 'data-label': 'Answer' }, c.correct_answer || '–'),
        el('td', { 'data-label': 'Status', class: 'ci-status' },
          err ? el('span', { class: 'ci-status__err' }, icon('warning-circle', { size: 'sm' }), el('span', null, err))
            : el('span', { class: 'ci-status__ok' }, icon('check-circle', { size: 'sm' }), 'Ready')));
    });
    const table = el('div', { class: 'table-wrap ci-tablewrap', tabindex: '0', role: 'region', 'aria-label': 'Rows found in the file' },
      el('table', { class: 'table table--compact ci-table' },
        el('thead', null, el('tr', null, ...['Row', 'Question', 'Category', 'Level', 'Answer', 'Status'].map((h, i) => el('th', { scope: 'col', class: i === 0 ? 'num' : null }, h)))),
        el('tbody', null, rows.length ? rows : el('tr', null, el('td', { colspan: 6, class: 'table__empty' }, 'No rows to show.')))));
    const more = visible.length > shown.length ? el('p', { class: 'ci-more u-muted' }, `Showing the first ${shown.length} of ${visible.length} rows. The whole file is checked.`) : null;

    body.replaceChildren(
      stepper(),
      el('p', { class: 'ci-file' }, icon('file-csv'), el('strong', null, file.name), el('span', { class: 'u-muted' }, ` · ${formatBytes(file.size)} · ${plural(all.length, 'row')} found`)),
      tiles, banner,
      el('div', { class: 'ci-tablehead' }, el('h3', { class: 'ci-help__title' }, 'File content'), filter),
      table, ...(more ? [more] : []));   // (replaceChildren(null) would print the word "null")
    announce(`${created} new, ${dry.skipped_duplicates || 0} duplicates, ${errors.length} errors`);

    setFooter(
      btn('Choose another file', { variant: 'ghost', iconName: 'arrow-left', onClick: () => { file = null; parsed = null; dry = null; chooseError = ''; renderChoose(); } }),
      el('span', { class: 'qe-footer__mid' }),
      btn('Cancel', { variant: 'ghost', onClick: () => panel.close(undefined) }),
      btn(created ? `Import ${plural(created, 'question')}` : 'Nothing to import', { variant: 'primary', iconName: 'file-arrow-up', disabled: created === 0, onClick: runImport }));
  }

  // ---- step 3: import + summary --------------------------------------------------------------------
  async function runImport() {
    busy = true;
    renderBusy(`Importing ${plural(dry.created || 0, 'question')}…`);
    try {
      finalResult = await ctx.api.upload(`/admin/events/${ctx.eventId}/questions/import-csv`, file, { query: { dry_run: false } });
      busy = false;
      imported = true;
      onImported?.(finalResult);
      renderDone();
    } catch (e) {
      busy = false;
      chooseError = describeError(e);
      renderPreview();
      body.prepend(el('div', { class: 'alert alert--danger', role: 'alert' }, icon('warning-fill', { class: 'alert__icon' }), el('div', null, el('p', { class: 'alert__title' }, 'The import failed'), el('p', { class: 'alert__text' }, chooseError))));
    }
  }

  function renderDone() {
    step = 'done';
    const r = finalResult;
    body.replaceChildren(
      stepper(),
      el('div', { class: 'ci-done' },
        el('span', { class: 'ci-done__icon' }, icon('check-circle-fill', { size: '2xl' })),
        el('h3', { class: 'ci-done__title' }, r.created ? `${plural(r.created, 'question')} imported` : 'Nothing was imported'),
        el('p', { class: 'u-muted' }, r.created ? 'They are in the pool now. New questions are active unless the file said otherwise.' : 'The file had no new valid question.')),
      el('div', { class: 'ci-tiles' },
        tile('Imported', r.created || 0, r.created ? 'ok' : null),
        tile('Duplicates skipped', r.skipped_duplicates || 0),
        tile('Categories created', r.categories_created || 0, r.categories_created ? 'info' : null),
        tile('Rows with errors', (r.errors || []).length, (r.errors || []).length ? 'bad' : null)));
    announce(`Import finished: ${r.created || 0} questions imported`);
    setFooter(
      btn('Import another file', { variant: 'ghost', iconName: 'file-arrow-up', onClick: () => { file = null; parsed = null; dry = null; chooseError = ''; renderChoose(); } }),
      el('span', { class: 'qe-footer__mid' }),
      btn('Done', { variant: 'primary', iconName: 'check', onClick: () => panel.close(imported ? finalResult : undefined) }));
    footer.querySelector('.btn--primary')?.focus();
  }

  renderChoose();
  return panel.closed;
}
