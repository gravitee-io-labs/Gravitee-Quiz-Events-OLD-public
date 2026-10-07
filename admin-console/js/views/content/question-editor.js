/**
 * Question editor: spacious dialog with the form on the left and a live player preview on the right.
 *
 *   await openQuestionEditor(ctx, { question, draft, categories, onSaved, onDeleted, onCategoriesChanged });
 *
 * - create (no `question`) or edit; `draft` pre-fills a new question (duplicate, carry-over)
 * - validation mirrors the backend; 422 responses are mapped back onto the fields
 * - Cmd/Ctrl+Enter = Save, Cmd/Ctrl+Shift+Enter = Save & add another, Esc = close (with an unsaved-changes guard)
 */
import { el, icon, relativeTime } from '../../../shared/js/dom.js';
import { announce, toast } from '../../../shared/js/ui.js';
import { openCategoryDialog } from './category-dialog.js';
import { createPreview } from './question-preview.js';
import {
  DIFFICULTY, LIMITS, TRUE_FALSE_LABELS, autoGrow, confirm, describeError, field, mapApiErrors, notify, openPanel, supportsFr, trim,
} from './common.js';

const FIELD_NAMES = [
  'question_text_en', 'question_text_fr', 'green_label_en', 'green_label_fr', 'red_label_en', 'red_label_fr',
  'explanation_en', 'explanation_fr', 'media_url', 'difficulty', 'category_id', 'correct_answer', 'question_format',
];
const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/i.test(navigator.platform || navigator.userAgent || '');
const MOD = isMac ? '⌘' : 'Ctrl';

function blankState(base = {}) {
  return {
    question_format: base.question_format || 'true_false',
    question_text_en: base.question_text_en ?? '',
    question_text_fr: base.question_text_fr ?? '',
    question_type: base.question_type || 'text',
    correct_answer: base.correct_answer || 'green',
    green_label_en: base.green_label_en ?? TRUE_FALSE_LABELS.green_label_en,
    green_label_fr: base.green_label_fr ?? TRUE_FALSE_LABELS.green_label_fr,
    red_label_en: base.red_label_en ?? TRUE_FALSE_LABELS.red_label_en,
    red_label_fr: base.red_label_fr ?? TRUE_FALSE_LABELS.red_label_fr,
    explanation_en: base.explanation_en ?? '',
    explanation_fr: base.explanation_fr ?? '',
    difficulty: base.difficulty ?? 1,
    category_id: base.category_id ?? null,
    is_active: base.is_active ?? true,
    media_url: base.media_url ?? '',
  };
}

/**
 * @param {object} ctx
 * @param {object} o
 * @param {object|null} [o.question] existing question to edit
 * @param {object|null} [o.draft] values for a new question
 * @param {object[]} o.categories live list (the editor pushes newly created categories into it)
 * @param {(q:object, info:{created:boolean})=>void} [o.onSaved]
 * @param {(q:object)=>void} [o.onDeleted]
 * @param {(cat:object)=>void} [o.onCategoryCreated]
 * @param {()=>HTMLElement|null} [o.restoreFocus]
 * @returns {Promise<void>} resolves when the editor closes
 */
export function openQuestionEditor(ctx, { question = null, draft = null, categories, onSaved, onDeleted, onCategoryCreated, restoreFocus } = {}) {
  const event = ctx.getEvent();
  const frOn = supportsFr(event);
  let mode = question ? 'edit' : 'create';
  let current = question;
  let f = blankState(question || draft || {});
  let baseline = JSON.stringify(f);
  let submitted = false;
  let busy = false;
  let addedCount = 0;
  const touched = new Set();
  let serverErrors = {};
  const customLabels = { green_label_en: '', green_label_fr: '', red_label_en: '', red_label_fr: '' };
  if (f.question_format === 'two_choices') for (const k of Object.keys(customLabels)) customLabels[k] = f[k];

  const preview = createPreview({ event });
  const offEvent = ctx.onEventChanged?.((e) => preview.setEvent(e));

  // ===========================================================================================
  // form controls
  // ===========================================================================================
  const formAlert = el('div', { class: 'alert alert--danger qe-alert', role: 'alert', hidden: true });

  // ---- format -----------------------------------------------------------------------------
  const formatRadios = [['true_false', 'check-circle', 'True / False'], ['two_choices', 'scales', 'Two choices']].map(([value, ic, label]) => ({
    value, input: el('input', { type: 'radio', name: 'qe-format', value }), node: null, label, ic,
  }));
  const formatSeg = el('div', { class: 'segmented segmented--block segmented--brand qe-format', role: 'radiogroup', 'aria-labelledby': 'qe-format-label' },
    ...formatRadios.map((r) => { r.node = el('label', null, r.input, el('span', null, icon(r.ic), r.label)); return r.node; }));
  const formatHelp = el('p', { class: 'field__help qe-format__help' });

  // ---- question text ----------------------------------------------------------------------
  const textEn = el('textarea', { class: 'textarea qv-ta qe-text', rows: 2, placeholder: 'e.g. HTTP status code 201 means a resource was created.', 'data-field': 'question_text_en' });
  const textFr = el('textarea', { class: 'textarea qv-ta qe-text', rows: 2, lang: 'fr', placeholder: 'ex. Le code HTTP 201 indique qu’une ressource a été créée.', 'data-field': 'question_text_fr' });
  const copyTextBtn = el('button', { type: 'button', class: 'btn btn--link btn--sm qe-copy', title: 'Copy the English question into the French field' }, icon('copy-simple', { size: 'sm' }), 'Copy from EN');
  const fTextEn = field({ label: 'Question (English)', control: textEn, counter: true });
  const fTextFr = field({ label: 'Question (French)', control: textFr, counter: true, optional: !frOn, extra: copyTextBtn });
  const textFrHint = el('p', { class: 'qe-hint qe-hint--warn', hidden: true });
  fTextFr.root.insertBefore(textFrHint, fTextFr.errorEl);

  // ---- answers ----------------------------------------------------------------------------
  const sides = {};
  for (const side of ['green', 'red']) {
    const en = el('input', { class: 'input', type: 'text', autocomplete: 'off', 'data-field': `${side}_label_en`, placeholder: side === 'green' ? 'e.g. Kong' : 'e.g. Tyk' });
    const fr = el('input', { class: 'input', type: 'text', autocomplete: 'off', lang: 'fr', 'data-field': `${side}_label_fr`, placeholder: 'Libellé français' });
    const fEn = field({ label: 'English label', control: en, counter: true });
    const fFr = field({ label: 'French label', control: fr, counter: true, optional: !frOn });
    const radio = el('input', { type: 'radio', class: 'radio', name: 'qe-correct', value: side, 'data-field': 'correct_answer' });
    const status = el('span', { class: 'qe-ans__status' });
    const bigEn = el('span', { class: 'qe-ans__big' });
    const bigFr = el('span', { class: 'qe-ans__bigfr', lang: 'fr' });
    const inputs = el('div', { class: 'qe-ans__inputs' }, fEn.root, fFr.root);
    const card = el('div', { class: ['qe-ans', `qe-ans--${side}`] },
      el('label', { class: 'qe-ans__pick' },
        radio,
        el('span', { class: 'qe-ans__head' },
          el('span', { class: `kbd kbd--${side}`, 'aria-hidden': 'true' }, side === 'green' ? 'G' : 'R'),
          el('span', { class: 'qe-ans__name' }, side === 'green' ? 'Green button' : 'Red button'),
          status),
        el('span', { class: 'qe-ans__tile' }, bigEn, bigFr)),
      inputs);
    sides[side] = { en, fr, fEn, fFr, radio, status, bigEn, bigFr, inputs, card };
  }
  const copyLabelsBtn = el('button', { type: 'button', class: 'btn btn--link btn--sm qe-copy' }, icon('copy-simple', { size: 'sm' }), 'Copy EN labels to FR');
  const answersHelp = el('p', { class: 'field__help' }, 'Pick the correct answer. The label is what players read on the button.');
  const answersSet = el('fieldset', { class: 'qe-answers' },
    el('legend', { class: 'field__label qe-legend' }, el('span', null, 'Answers'), copyLabelsBtn),
    answersHelp,
    el('div', { class: 'qe-answers__grid' }, sides.green.card, sides.red.card));
  const correctErr = el('p', { class: 'field__error', hidden: true });
  answersSet.append(correctErr);

  // ---- explanation ------------------------------------------------------------------------
  const explEn = el('textarea', { class: 'textarea qv-ta', rows: 2, placeholder: 'Shown after the answer so players learn something.', 'data-field': 'explanation_en' });
  const explFr = el('textarea', { class: 'textarea qv-ta', rows: 2, lang: 'fr', placeholder: 'Affichée après la réponse.', 'data-field': 'explanation_fr' });
  const copyExplBtn = el('button', { type: 'button', class: 'btn btn--link btn--sm qe-copy' }, icon('copy-simple', { size: 'sm' }), 'Copy from EN');
  const fExplEn = field({ label: 'Explanation (English)', control: explEn, optional: true, counter: true });
  const fExplFr = field({ label: 'Explanation (French)', control: explFr, optional: true, counter: true, extra: copyExplBtn });
  const explFrHint = el('p', { class: 'qe-hint', hidden: true });
  fExplFr.root.insertBefore(explFrHint, fExplFr.errorEl);

  // ---- settings ---------------------------------------------------------------------------
  const diffInputs = new Map();
  const diffSeg = el('div', { class: 'segmented segmented--block qe-diff', role: 'radiogroup', 'aria-labelledby': 'qe-diff-label' });
  const addDiff = (level) => {
    if (diffInputs.has(level)) return;
    const input = el('input', { type: 'radio', name: 'qe-difficulty', value: String(level) });
    diffInputs.set(level, input);
    diffSeg.append(el('label', null, input, el('span', null, el('span', { class: 'difficulty', 'data-level': Math.min(level, 3), 'aria-hidden': 'true' }), DIFFICULTY[level])));
    input.addEventListener('change', () => { if (input.checked) { f.difficulty = level; onChange('difficulty'); } });
  };
  [1, 2, 3].forEach(addDiff);

  const categorySel = el('select', { class: 'select', 'data-field': 'category_id' });
  const newCatBtn = el('button', { type: 'button', class: 'btn btn--secondary btn--icon', 'aria-label': 'New category', title: 'New category' }, icon('plus'));
  const fCategory = field({ label: 'Category', control: categorySel, optional: true });
  const catRow = el('div', { class: 'qe-catrow' }, categorySel, newCatBtn);
  fCategory.root.classList.add('qe-cell--cat');
  fCategory.root.insertBefore(catRow, fCategory.errorEl);

  const mediaIn = el('input', { class: 'input', type: 'text', inputmode: 'url', autocomplete: 'off', placeholder: 'Secure image link or /assets/photo.png', 'data-field': 'media_url' });
  const fMedia = field({ label: 'Image URL', control: mediaIn, optional: true, help: 'Shown above the question. https:// or a path starting with /.' });

  const activeIn = el('input', { type: 'checkbox', class: 'switch', role: 'switch' });
  const activeRow = el('label', { class: 'check qe-active qe-cell--active' }, activeIn,
    el('span', { class: 'check__text' }, 'Active', el('span', { class: 'check__hint' }, 'Inactive questions are never drawn in games.')));

  const form = el('form', { class: 'qe-form', novalidate: true, autocomplete: 'off' },
    formAlert,
    el('section', { class: 'qe-sec qe-meta' },
      el('div', { class: 'field qe-cell--format' }, el('span', { class: 'field__label', id: 'qe-format-label' }, 'Answer format'), formatSeg, formatHelp),
      el('div', { class: 'field qe-cell--diff' }, el('span', { class: 'field__label', id: 'qe-diff-label' }, 'Difficulty'), diffSeg),
      fCategory.root,
      activeRow),
    el('section', { class: 'qe-sec qe-sec--text' }, el('div', { class: 'qv-pair' }, fTextEn.root, fTextFr.root)),
    el('section', { class: 'qe-sec qe-sec--answers' }, answersSet),
    el('section', { class: 'qe-sec qe-sec--expl' }, el('div', { class: 'qv-pair' }, fExplEn.root, fExplFr.root)),
    el('section', { class: 'qe-sec qe-sec--media qe-media' }, fMedia.root));

  // ---- footer -----------------------------------------------------------------------------
  const deleteBtn = el('button', { type: 'button', class: 'btn btn--ghost qv-danger' }, icon('trash'), 'Delete');
  const dupBtn = el('button', { type: 'button', class: 'btn btn--ghost' }, icon('copy'), 'Duplicate');
  const status = el('span', { class: 'qe-status', role: 'status', 'aria-live': 'polite' });
  const cancelBtn = el('button', { type: 'button', class: 'btn btn--ghost' }, 'Cancel');
  const anotherBtn = el('button', { type: 'button', class: 'btn btn--secondary', title: `${MOD}+Shift+Enter` }, icon('plus'), 'Save & add another');
  const saveBtn = el('button', { type: 'button', class: 'btn btn--primary', title: `${MOD}+Enter` }, icon('floppy-disk'), 'Save');
  const hint = el('span', { class: 'qe-keys u-hide-sm' }, el('span', { class: 'kbd' }, MOD), el('span', { class: 'kbd' }, '↵'), el('span', null, 'to save'));
  const footer = el('div', { class: 'dialog__footer qe-footer' },
    el('div', { class: 'qe-footer__left' }, deleteBtn, dupBtn),
    el('div', { class: 'qe-footer__mid' }, status, hint),
    el('div', { class: 'qe-footer__right' }, cancelBtn, anotherBtn, saveBtn));

  // ---- layout: form + preview (stacked behind a toggle on small screens) --------------------
  const viewRadios = [['edit', 'pencil-simple', 'Edit'], ['preview', 'eye', 'Preview']].map(([value, ic, label]) => ({ value, input: el('input', { type: 'radio', name: 'qe-view', value, checked: value === 'edit' }), ic, label }));
  const viewToggle = el('div', { class: 'segmented segmented--block qe-viewtoggle', role: 'radiogroup', 'aria-label': 'Editor view' },
    ...viewRadios.map((r) => el('label', null, r.input, el('span', null, icon(r.ic), r.label))));
  const layout = el('div', { class: 'qe-layout', 'data-view': 'edit' },
    viewToggle,
    el('div', { class: 'qe-main' }, form),
    el('aside', { class: 'qe-aside' }, preview.root));
  viewRadios.forEach((r) => r.input.addEventListener('change', () => { if (r.input.checked) layout.dataset.view = r.value; }));

  const addedBadge = el('span', { class: 'badge badge--success qe-added', hidden: true });

  // ===========================================================================================
  // state <-> DOM
  // ===========================================================================================
  const refsByName = {
    question_text_en: fTextEn, question_text_fr: fTextFr,
    green_label_en: sides.green.fEn, green_label_fr: sides.green.fFr, red_label_en: sides.red.fEn, red_label_fr: sides.red.fFr,
    explanation_en: fExplEn, explanation_fr: fExplFr, media_url: fMedia, category_id: fCategory,
  };
  const textareas = [textEn, textFr, explEn, explFr];
  const bindings = [
    [textEn, 'question_text_en'], [textFr, 'question_text_fr'], [explEn, 'explanation_en'], [explFr, 'explanation_fr'], [mediaIn, 'media_url'],
    [sides.green.en, 'green_label_en'], [sides.green.fr, 'green_label_fr'], [sides.red.en, 'red_label_en'], [sides.red.fr, 'red_label_fr'],
  ];

  function pushState() {
    for (const [input, key] of bindings) input.value = f[key] ?? '';
    for (const r of formatRadios) r.input.checked = r.value === f.question_format;
    for (const side of ['green', 'red']) sides[side].radio.checked = f.correct_answer === side;
    if (f.difficulty > 3) addDiff(f.difficulty);
    for (const [level, input] of diffInputs) input.checked = level === Number(f.difficulty);
    activeIn.checked = !!f.is_active;
    renderCategoryOptions();
    textareas.forEach(autoGrow);
  }

  function renderCategoryOptions() {
    const opts = [el('option', { value: '' }, 'No category')];
    for (const c of categories) opts.push(el('option', { value: String(c.id) }, c.is_active ? c.name : `${c.name} (inactive)`));
    categorySel.replaceChildren(...opts);
    categorySel.value = f.category_id == null ? '' : String(f.category_id);
    if (categorySel.value !== (f.category_id == null ? '' : String(f.category_id))) { categorySel.value = ''; }
  }

  const isDirty = () => JSON.stringify(f) !== baseline;

  function validate() {
    const e = {};
    const en = trim(f.question_text_en);
    if (!en) e.question_text_en = 'Write the question in English.';
    else if (en.length > LIMITS.questionText) e.question_text_en = `At most ${LIMITS.questionText} characters.`;
    if (trim(f.question_text_fr).length > LIMITS.questionText) e.question_text_fr = `At most ${LIMITS.questionText} characters.`;
    if (trim(f.explanation_en).length > LIMITS.explanation) e.explanation_en = `At most ${LIMITS.explanation} characters.`;
    if (trim(f.explanation_fr).length > LIMITS.explanation) e.explanation_fr = `At most ${LIMITS.explanation} characters.`;
    if (f.question_format === 'two_choices') {
      for (const side of ['green', 'red']) {
        for (const lang of ['en', 'fr']) {
          const key = `${side}_label_${lang}`;
          const v = trim(f[key]);
          if (!v) { if (lang === 'en' || frOn) e[key] = lang === 'en' ? 'Both answers need a label.' : 'Add the French label (or copy the English one).'; }
          else if (v.length > LIMITS.labelMax) e[key] = `Too long for a button (max ${LIMITS.labelMax} characters).`;
        }
      }
      if (!e.green_label_en && !e.red_label_en && trim(f.green_label_en).toLowerCase() === trim(f.red_label_en).toLowerCase()) e.red_label_en = 'The two answers must be different.';
    }
    const media = trim(f.media_url);
    if (media && (media.length > LIMITS.mediaUrl || !/^(https:\/\/\S+|\/(?!\/)\S*)$/.test(media))) e.media_url = 'Use an https:// URL or a path starting with / (max 500 characters).';
    return e;
  }

  const hasFrGap = () => frOn && !trim(f.question_text_fr);

  function refresh() {
    const errors = validate();
    // inline errors (only for touched fields / after a submit attempt / from the server)
    for (const [name, ref] of Object.entries(refsByName)) {
      const show = submitted || touched.has(name) || serverErrors[name];
      ref.setError(show ? (serverErrors[name] || errors[name] || '') : '');
    }
    const cMsg = serverErrors.correct_answer || '';
    correctErr.hidden = !cMsg; correctErr.replaceChildren(...(cMsg ? [icon('warning-circle', { size: 'sm' }), el('span', null, cMsg)] : []));

    fTextEn.setCounter(trim(f.question_text_en).length, { max: LIMITS.questionText });
    fTextFr.setCounter(trim(f.question_text_fr).length, { max: LIMITS.questionText });
    fExplEn.setCounter(trim(f.explanation_en).length, { max: LIMITS.explanation });
    fExplFr.setCounter(trim(f.explanation_fr).length, { max: LIMITS.explanation });

    const tf = f.question_format === 'true_false';
    formatHelp.textContent = tf
      ? 'TRUE or FALSE. Labels are filled in for you (Vrai / Faux in French).'
      : 'Two custom answers, one per button. Keep them short: they must fit a phone button.';
    for (const side of ['green', 'red']) {
      const s = sides[side];
      const correct = f.correct_answer === side;
      s.card.classList.toggle('is-correct', correct);
      s.status.replaceChildren(icon(correct ? 'check-circle-fill' : 'x-circle', { size: 'sm' }), correct ? 'Correct answer' : 'Wrong answer');
      s.inputs.hidden = tf;
      s.en.disabled = tf; s.fr.disabled = tf;
      const en = trim(f[`${side}_label_en`]);
      const fr = trim(f[`${side}_label_fr`]);
      s.bigEn.textContent = en || (tf ? '' : 'Label');
      s.bigEn.classList.toggle('is-placeholder', !en);
      s.bigFr.textContent = fr && fr !== en ? fr : '';
      s.fEn.setCounter(en.length, { ideal: LIMITS.labelIdeal, max: LIMITS.labelMax });
      s.fFr.setCounter(fr.length, { ideal: LIMITS.labelIdeal, max: LIMITS.labelMax });
    }
    copyLabelsBtn.hidden = tf;
    answersHelp.hidden = false;

    // translation hints
    textFrHint.hidden = !hasFrGap();
    textFrHint.replaceChildren(...(hasFrGap() ? [icon('translate', { size: 'sm' }), el('span', null, 'No French text yet: French players will see the English question.')] : []));
    const explGap = frOn && !!trim(f.explanation_en) && !trim(f.explanation_fr);
    explFrHint.hidden = !explGap;
    explFrHint.replaceChildren(...(explGap ? [icon('info', { size: 'sm' }), el('span', null, 'The explanation is not translated yet.')] : []));
    copyTextBtn.disabled = !trim(f.question_text_en);
    copyExplBtn.disabled = !trim(f.explanation_en);
    copyLabelsBtn.disabled = !trim(f.green_label_en) && !trim(f.red_label_en);

    // media field is optional, its preview lives in the preview panel
    const cat = categories.find((c) => c.id === f.category_id) || null;
    preview.update({ ...f, category: cat });

    // chrome
    const dirty = isDirty();
    status.textContent = busy ? 'Saving…' : dirty ? 'Unsaved changes' : (mode === 'edit' ? 'All changes saved' : '');
    status.classList.toggle('is-dirty', dirty && !busy);
    ctx.setDirty?.(dirty);
    addedBadge.hidden = addedCount === 0;
    addedBadge.textContent = `${addedCount} added`;
    return errors;
  }

  function onChange(name) {
    if (name) { delete serverErrors[name]; }
    refresh();
  }

  // ---- bindings ---------------------------------------------------------------------------
  for (const [input, key] of bindings) {
    input.addEventListener('input', () => {
      f[key] = input.value;
      if (f.question_format === 'two_choices' && key in customLabels) customLabels[key] = input.value;
      if (input.tagName === 'TEXTAREA') autoGrow(input);
      onChange(key);
    });
    input.addEventListener('blur', () => { touched.add(key); refresh(); });
  }
  formatRadios.forEach((r) => r.input.addEventListener('change', () => { if (r.input.checked) setFormat(r.value); }));
  for (const side of ['green', 'red']) sides[side].radio.addEventListener('change', () => { f.correct_answer = side; onChange('correct_answer'); });
  activeIn.addEventListener('change', () => { f.is_active = activeIn.checked; refresh(); });
  categorySel.addEventListener('change', () => { f.category_id = categorySel.value === '' ? null : Number(categorySel.value); onChange('category_id'); });

  function setFormat(next) {
    if (f.question_format === next) return;
    if (next === 'true_false') {
      for (const k of Object.keys(customLabels)) customLabels[k] = f[k];
      Object.assign(f, TRUE_FALSE_LABELS);
    } else {
      const hadCustom = Object.values(customLabels).some(Boolean);
      for (const k of Object.keys(customLabels)) f[k] = hadCustom ? customLabels[k] : '';
    }
    f.question_format = next;
    for (const [input, key] of bindings) if (key in customLabels) input.value = f[key];
    onChange('question_format');
    if (next === 'two_choices') sides.green.en.focus();
  }

  const doCopy = (from, to, label) => {
    const previous = f[to];
    if (!trim(f[from])) return;
    f[to] = f[from];
    const target = bindings.find(([, k]) => k === to)[0];
    target.value = f[to];
    if (target.tagName === 'TEXTAREA') autoGrow(target);
    onChange(to);
    if (trim(previous) && previous !== f[to]) {
      toast(`${label} replaced by the English version`, { type: 'info', action: { label: 'Undo', onClick: () => { f[to] = previous; target.value = previous; if (target.tagName === 'TEXTAREA') autoGrow(target); onChange(to); } } });
    } else announce(`${label} copied from English`);
  };
  copyTextBtn.addEventListener('click', () => { doCopy('question_text_en', 'question_text_fr', 'French question'); textFr.focus(); });
  copyExplBtn.addEventListener('click', () => { doCopy('explanation_en', 'explanation_fr', 'French explanation'); explFr.focus(); });
  copyLabelsBtn.addEventListener('click', () => {
    const before = { ...f };
    for (const side of ['green', 'red']) {
      const en = trim(f[`${side}_label_en`]);
      if (en) { f[`${side}_label_fr`] = en; customLabels[`${side}_label_fr`] = en; }
    }
    for (const [input, key] of bindings) if (key in customLabels) input.value = f[key];
    onChange('green_label_fr');
    toast('French labels set from the English ones', { type: 'info', action: { label: 'Undo', onClick: () => { for (const k of Object.keys(customLabels)) { f[k] = before[k]; customLabels[k] = before[k]; } for (const [input, key] of bindings) if (key in customLabels) input.value = f[key]; onChange('green_label_fr'); } } });
  });

  async function newCategory() {
    const created = await openCategoryDialog(ctx, { categories, restoreFocus: () => newCatBtn });
    if (!created) return;
    categories.push(created);
    onCategoryCreated?.(created);
    f.category_id = created.id;
    touched.add('category_id');
    renderCategoryOptions();
    refresh();
    categorySel.focus();
    notify(ctx, `Category “${created.name}” created and selected`, 'success');
  }
  newCatBtn.addEventListener('click', newCategory);

  // ===========================================================================================
  // save / delete / duplicate
  // ===========================================================================================
  function buildPayload() {
    const tf = f.question_format === 'true_false';
    const labels = tf ? TRUE_FALSE_LABELS : {
      green_label_en: trim(f.green_label_en), green_label_fr: trim(f.green_label_fr) || null,
      red_label_en: trim(f.red_label_en), red_label_fr: trim(f.red_label_fr) || null,
    };
    // the player app only shows a picture when question_type is not "text": an image URL therefore makes it an "image" question
    const media = trim(f.media_url);
    const questionType = media ? (f.question_type && f.question_type !== 'text' ? f.question_type : 'image') : 'text';
    return {
      question_type: questionType,
      category_id: f.category_id,
      question_format: f.question_format,
      difficulty: Number(f.difficulty) || 1,
      question_text_en: trim(f.question_text_en),
      question_text_fr: trim(f.question_text_fr) || null,
      correct_answer: f.correct_answer,
      ...labels,
      explanation_en: trim(f.explanation_en) || null,
      explanation_fr: trim(f.explanation_fr) || null,
      media_url: trim(f.media_url) || null,
      is_active: !!f.is_active,
    };
  }

  function focusFirstError(errors) {
    const order = ['question_text_en', 'question_text_fr', 'green_label_en', 'green_label_fr', 'red_label_en', 'red_label_fr', 'explanation_en', 'explanation_fr', 'category_id', 'media_url'];
    const name = order.find((k) => errors[k] || serverErrors[k]);
    if (!name) return;
    layout.dataset.view = 'edit';
    viewRadios[0].input.checked = true;
    refsByName[name]?.input?.focus();
  }

  function setBusy(on) {
    busy = on;
    for (const b of [saveBtn, anotherBtn, deleteBtn, dupBtn]) b.disabled = on;
    saveBtn.classList.toggle('is-loading', on);
    if (on) saveBtn.setAttribute('aria-busy', 'true'); else saveBtn.removeAttribute('aria-busy');
  }

  async function save({ another = false } = {}) {
    if (busy) return;
    submitted = true;
    formAlert.hidden = true;
    const errors = refresh();
    if (Object.keys(errors).length) {
      focusFirstError(errors);
      announce(`${Object.keys(errors).length} field${Object.keys(errors).length === 1 ? '' : 's'} to fix`, { politeness: 'assertive' });
      return;
    }
    setBusy(true);
    refresh();
    const created = mode === 'create';
    try {
      const payload = buildPayload();
      const saved = created
        ? await ctx.api.post(`/admin/events/${ctx.eventId}/questions`, payload)
        : await ctx.api.put(`/admin/questions/${current.id}`, payload);
      setBusy(false);
      onSaved?.(saved, { created });
      if (another) {
        addedCount += 1;
        const carry = { category_id: f.category_id, difficulty: f.difficulty, question_format: f.question_format, is_active: f.is_active };
        loadInto(null, carry);
        notify(ctx, 'Question saved. Ready for the next one.', 'success');
        announce('Question saved. Form cleared for a new question.');
        textEn.focus();
      } else {
        notify(ctx, created ? 'Question added' : 'Question saved', 'success');
        panel.close(saved, { force: true });
      }
    } catch (err) {
      setBusy(false);
      const { fields, form: formMessage } = mapApiErrors(err, FIELD_NAMES);
      serverErrors = fields;
      if (formMessage) {
        formAlert.replaceChildren(icon('warning-fill', { class: 'alert__icon' }), el('div', null, el('p', { class: 'alert__title' }, 'Could not save the question'), el('p', { class: 'alert__text' }, formMessage)));
        formAlert.hidden = false;
        formAlert.scrollIntoView({ block: 'nearest' });
      }
      const e2 = refresh();
      focusFirstError({ ...e2 });
    }
  }

  async function remove() {
    if (mode !== 'edit' || busy) return;
    const snippet = trim(current.question_text_en);
    const ok = await confirm(ctx, {
      title: 'Delete this question?',
      message: `“${snippet.length > 120 ? `${snippet.slice(0, 117)}…` : snippet}” will be removed from the pool. Answers recorded for it in past games are removed too. This cannot be undone.`,
      confirmLabel: 'Delete question', danger: true,
    });
    if (!ok) return;
    setBusy(true);
    try {
      await ctx.api.delete(`/admin/questions/${current.id}`);
      setBusy(false);
      onDeleted?.(current);
      notify(ctx, 'Question deleted', 'success');
      panel.close(undefined, { force: true });
    } catch (err) {
      setBusy(false);
      notify(ctx, describeError(err), 'error');
    }
  }

  async function duplicate() {
    if (mode !== 'edit' || busy) return;
    if (isDirty()) {
      const ok = await confirm(ctx, { title: 'Duplicate with your edits?', message: 'The copy starts from what you see now, including unsaved edits. The original keeps its last saved version.', confirmLabel: 'Duplicate' });
      if (!ok) return;
    }
    loadInto(null, { ...f, id: undefined }, { duplicate: true });
    notify(ctx, 'Editing a copy: save to add it to the pool.', 'info');
    textEn.focus();
    textEn.select();
  }

  function loadInto(q, base = {}, { duplicate = false } = {}) {
    current = q;
    mode = q ? 'edit' : 'create';
    f = blankState(q || base);
    for (const k of Object.keys(customLabels)) customLabels[k] = f.question_format === 'two_choices' ? f[k] : '';
    baseline = duplicate ? '' : JSON.stringify(f); // a duplicate counts as dirty until it is saved
    submitted = false; touched.clear(); serverErrors = {};
    formAlert.hidden = true;
    pushState();
    chrome();
    refresh();
  }

  function chrome() {
    const editing = mode === 'edit';
    deleteBtn.hidden = !editing;
    dupBtn.hidden = !editing;
    anotherBtn.hidden = false;
    saveBtn.replaceChildren(icon('floppy-disk'), editing ? 'Save changes' : 'Add question');
    panel?.setTitle(editing ? 'Edit question' : 'New question', editing && current
      ? `#${current.id} · edited ${relativeTime(current.updated_at)}`
      : 'Write it once in English, add French when you can.');
  }

  deleteBtn.addEventListener('click', remove);
  dupBtn.addEventListener('click', duplicate);
  saveBtn.addEventListener('click', () => save());
  anotherBtn.addEventListener('click', () => save({ another: true }));
  form.addEventListener('submit', (e) => { e.preventDefault(); save(); });

  // ===========================================================================================
  // panel
  // ===========================================================================================
  let panel = null;
  panel = openPanel({
    title: 'Question', iconName: 'question', size: 'xl', className: 'qe', content: layout, footer, restoreFocus, initialFocus: textEn, headerExtra: addedBadge,
    beforeClose: async () => {
      if (busy) return false;
      if (!isDirty()) return true;
      return confirm(ctx, {
        title: 'Discard your changes?',
        message: mode === 'edit' ? 'This question has unsaved changes.' : 'This question has not been saved yet.',
        confirmLabel: 'Discard', danger: true,
      });
    },
  });
  cancelBtn.addEventListener('click', () => panel.close(undefined));
  panel.dialog.addEventListener('keydown', (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') { e.preventDefault(); save({ another: e.shiftKey }); }
  });
  loadInto(question || null, draft || {}, { duplicate: !!draft?.__duplicate });

  return panel.closed.finally(() => { offEvent?.(); ctx.setDirty?.(false); });
}
