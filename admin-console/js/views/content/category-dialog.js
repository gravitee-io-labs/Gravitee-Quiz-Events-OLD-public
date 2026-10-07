/**
 * Create / edit category dialog. Used by the Categories tab and, for "new category on the fly", by the question editor.
 *
 *   const saved = await openCategoryDialog(ctx, { category, categories });   // Category | null (cancelled)
 */
import { el, icon, uid } from '../../../shared/js/dom.js';
import { initColorInputs } from '../../../shared/js/ui.js';
import { LIMITS, PALETTE, confirm, describeError, field, mapApiErrors, normalizeHex, openPanel, supportsFr, trim, autoGrow } from './common.js';

const FIELDS = ['name', 'name_fr', 'description', 'description_fr', 'color', 'is_active'];

/**
 * @param {object} ctx admin view context (api, getEvent, eventId, toast, confirm)
 * @param {{category?: object|null, categories?: object[], defaultName?: string, restoreFocus?: ()=>HTMLElement|null}} [opts]
 * @returns {Promise<object|null>} the saved category (with question_count) or null
 */
export function openCategoryDialog(ctx, { category = null, categories = [], defaultName = '', restoreFocus } = {}) {
  const editing = !!category;
  const event = ctx.getEvent?.();
  const frOn = supportsFr(event);
  const usedColors = new Set(categories.filter((c) => !category || c.id !== category.id).map((c) => String(c.color).toUpperCase()));
  const firstFree = PALETTE.find(([hex]) => !usedColors.has(hex))?.[0] || PALETTE[0][0];

  const state = {
    name: category?.name ?? defaultName,
    name_fr: category?.name_fr ?? '',
    description: category?.description ?? '',
    description_fr: category?.description_fr ?? '',
    color: (category?.color || firstFree).toUpperCase(),
    is_active: category?.is_active ?? true,
  };
  const initial = JSON.stringify(state);
  let busy = false;
  let submitted = false;

  // ---- fields ---------------------------------------------------------------------------
  const nameIn = el('input', { class: 'input', type: 'text', maxlength: LIMITS.name, autocomplete: 'off', value: state.name, placeholder: 'e.g. REST APIs' });
  const nameFrIn = el('input', { class: 'input', type: 'text', maxlength: LIMITS.name, autocomplete: 'off', value: state.name_fr, placeholder: 'e.g. API REST' });
  const descIn = el('textarea', { class: 'textarea qv-ta', rows: 2, value: state.description, placeholder: 'One line shown on the landing page' });
  const descFrIn = el('textarea', { class: 'textarea qv-ta', rows: 2, value: state.description_fr, placeholder: 'Une ligne affichée sur la page d’accueil' });
  const fName = field({ label: 'Name (English)', control: nameIn, counter: true });
  const fNameFr = field({ label: 'Name (French)', control: nameFrIn, optional: true, counter: true, help: frOn ? 'Shown to players playing in French.' : 'French is not enabled for this event.' });
  const fDesc = field({ label: 'Description (English)', control: descIn, optional: true });
  const fDescFr = field({ label: 'Description (French)', control: descFrIn, optional: true });

  // colour: presets + native picker + hex
  const swatchBtns = PALETTE.map(([hex, label]) => el('button', {
    type: 'button', class: 'swatch qv-swatch', style: { '--swatch': hex, '--swatch-2': hex }, 'aria-label': label, 'aria-pressed': 'false', title: `${label} ${hex}`, dataset: { color: hex },
  }));
  const colorPicker = el('input', { type: 'color', class: 'color-input__swatch', 'aria-label': 'Pick a colour', value: state.color.toLowerCase() });
  const hexIn = el('input', { class: 'input color-input__hex', type: 'text', maxlength: 7, 'aria-label': 'Colour hex code', value: state.color, spellcheck: 'false', autocomplete: 'off' });
  const colorWrap = el('div', { class: 'color-input qv-color-input' }, colorPicker, hexIn);
  const colorErr = el('p', { class: 'field__error', hidden: true });
  const colorField = el('div', { class: 'field qv-color-field' },
    el('span', { class: 'field__label', id: 'qv-color-label' }, 'Colour'),
    el('div', { class: 'qv-colorrow' },
      el('div', { class: 'qv-swatches', role: 'group', 'aria-labelledby': 'qv-color-label' }, swatchBtns),
      colorWrap),
    colorErr);

  const activeIn = el('input', { type: 'checkbox', class: 'switch', role: 'switch', checked: state.is_active });
  const activeRow = el('label', { class: 'check qv-active-row' }, activeIn,
    el('span', { class: 'check__text' }, 'Active', el('span', { class: 'check__hint' }, 'Inactive categories are hidden from players and left out of game selection.')));

  // live preview chip
  const chipEn = el('span', { class: 'chip' });
  const chipFr = el('span', { class: 'chip' });
  const preview = el('div', { class: 'qv-cat-preview', 'aria-label': 'Preview' },
    el('span', { class: 'qv-cat-preview__label' }, 'Preview'),
    el('div', { class: 'chips' }, chipEn, frOn ? chipFr : null));

  const formAlert = el('div', { class: 'alert alert--danger', role: 'alert', hidden: true });
  const formId = uid('qv-catform');
  const form = el('form', { class: 'qv-catform', id: formId, novalidate: true },
    formAlert,
    el('div', { class: 'qv-pair' }, fName.root, fNameFr.root),
    el('div', { class: 'qv-pair' }, fDesc.root, fDescFr.root),
    colorField,
    el('div', { class: 'qv-cat-foot' }, preview, activeRow));

  // ---- behaviour -------------------------------------------------------------------------
  const disposeColor = initColorInputs(form);
  const dirty = () => JSON.stringify(state) !== initial;
  const serverErrors = {};

  const nameKey = (s) => trim(s).replace(/\s+/g, ' ').toLowerCase();
  function validate() {
    const errors = {};
    if (!trim(state.name)) errors.name = 'Give the category a name.';
    else if (trim(state.name).length > LIMITS.name) errors.name = `At most ${LIMITS.name} characters.`;
    else if (categories.some((c) => (!category || c.id !== category.id) && nameKey(c.name) === nameKey(state.name))) errors.name = 'Another category in this event already has this name.';
    if (trim(state.name_fr).length > LIMITS.name) errors.name_fr = `At most ${LIMITS.name} characters.`;
    if (trim(state.description).length > LIMITS.description) errors.description = `At most ${LIMITS.description} characters.`;
    if (trim(state.description_fr).length > LIMITS.description) errors.description_fr = `At most ${LIMITS.description} characters.`;
    if (!normalizeHex(state.color)) errors.color = 'Use a 6-digit hex colour such as #FC5607.';
    return errors;
  }
  const touched = new Set();
  const fieldMap = { name: fName, name_fr: fNameFr, description: fDesc, description_fr: fDescFr };

  function refresh() {
    const errors = validate();
    for (const [key, f] of Object.entries(fieldMap)) {
      const show = submitted || touched.has(key) || serverErrors[key];
      f.setError(show ? (serverErrors[key] || errors[key] || '') : '');
    }
    const colorMsg = (submitted || touched.has('color')) ? (serverErrors.color || errors.color) : '';
    colorErr.hidden = !colorMsg;
    colorErr.replaceChildren(...(colorMsg ? [icon('warning-circle', { size: 'sm' }), el('span', null, colorMsg)] : []));
    fName.setCounter(trim(state.name).length, { max: LIMITS.name });
    fNameFr.setCounter(trim(state.name_fr).length, { max: LIMITS.name });
    const hex = normalizeHex(state.color);
    for (const b of swatchBtns) b.setAttribute('aria-pressed', String(!!hex && b.dataset.color === hex));
    const chipColor = hex || '#888888';
    chipEn.style.setProperty('--chip', chipColor);
    chipEn.textContent = trim(state.name) || 'Category name';
    chipFr.style.setProperty('--chip', chipColor);
    chipFr.textContent = trim(state.name_fr) || trim(state.name) || 'Nom de la catégorie';
    chipFr.title = trim(state.name_fr) ? '' : 'No French name: players in French see the English one';
    return errors;
  }

  const bindText = (input, key) => input.addEventListener('input', () => {
    state[key] = input.value;
    delete serverErrors[key];
    if (input.tagName === 'TEXTAREA') autoGrow(input);
    refresh();
  });
  const bindBlur = (input, key) => input.addEventListener('blur', () => { touched.add(key); refresh(); });
  [[nameIn, 'name'], [nameFrIn, 'name_fr'], [descIn, 'description'], [descFrIn, 'description_fr']].forEach(([i, k]) => { bindText(i, k); bindBlur(i, k); });

  form.addEventListener('input', (e) => {
    if (e.target === colorPicker || e.target === hexIn) {
      state.color = e.target === colorPicker ? colorPicker.value.toUpperCase() : hexIn.value.trim().toUpperCase();
      delete serverErrors.color;
      refresh();
    }
  });
  hexIn.addEventListener('blur', () => { touched.add('color'); const n = normalizeHex(hexIn.value); if (n) { state.color = n; hexIn.value = n; colorPicker.value = n.toLowerCase(); } refresh(); });
  swatchBtns.forEach((b) => b.addEventListener('click', () => {
    state.color = b.dataset.color; colorPicker.value = state.color.toLowerCase(); hexIn.value = state.color; hexIn.removeAttribute('aria-invalid');
    delete serverErrors.color; refresh();
  }));
  activeIn.addEventListener('change', () => { state.is_active = activeIn.checked; });

  // ---- footer + save ---------------------------------------------------------------------
  const saveBtn = el('button', { type: 'submit', class: 'btn btn--primary', form: formId }, icon(editing ? 'floppy-disk' : 'plus'), editing ? 'Save changes' : 'Create category');
  const cancelBtn = el('button', { type: 'button', class: 'btn btn--ghost' }, 'Cancel');
  const footer = el('div', { class: 'dialog__footer' }, cancelBtn, saveBtn);

  const panel = openPanel({
    title: editing ? 'Edit category' : 'New category',
    description: editing ? `${category.question_count ?? 0} question${category.question_count === 1 ? '' : 's'} in this category` : 'Categories group the questions and are balanced in every game.',
    iconName: 'tag', size: 'lg', className: 'qv-catdialog',
    content: form, footer, restoreFocus, initialFocus: nameIn,
    beforeClose: async (value) => {
      if (value !== undefined && value !== null) return true; // saved
      if (!dirty() || busy) return !busy;
      return confirm(ctx, { title: 'Discard your changes?', message: 'The category has not been saved yet.', confirmLabel: 'Discard', danger: true });
    },
  });
  cancelBtn.addEventListener('click', () => panel.close(undefined));
  panel.dialog.addEventListener('keydown', (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') { e.preventDefault(); form.requestSubmit(); }
  });
  panel.dialog.addEventListener('close', disposeColor, { once: true });
  refresh();
  [descIn, descFrIn].forEach(autoGrow);

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (busy) return;
    submitted = true;
    const errors = refresh();
    formAlert.hidden = true;
    const firstBad = Object.keys(errors)[0];
    if (firstBad) {
      (firstBad === 'color' ? hexIn : fieldMap[firstBad].input).focus();
      return;
    }
    const payload = {
      name: trim(state.name), name_fr: trim(state.name_fr) || null,
      description: trim(state.description) || null, description_fr: trim(state.description_fr) || null,
      color: normalizeHex(state.color), is_active: !!state.is_active,
    };
    busy = true; saveBtn.disabled = true; saveBtn.classList.add('is-loading'); saveBtn.setAttribute('aria-busy', 'true');
    try {
      const saved = editing
        ? await ctx.api.put(`/admin/categories/${category.id}`, payload)
        : await ctx.api.post(`/admin/events/${ctx.eventId}/categories`, payload);
      busy = false;
      await panel.close(saved ?? { ...category, ...payload }, { force: true });
    } catch (err) {
      busy = false;
      saveBtn.disabled = false; saveBtn.classList.remove('is-loading'); saveBtn.removeAttribute('aria-busy');
      if (err?.status === 409) serverErrors.name = describeError(err);
      else {
        const { fields, form: formMessage } = mapApiErrors(err, FIELDS);
        Object.assign(serverErrors, fields);
        if (formMessage) {
          formAlert.replaceChildren(icon('warning-fill', { class: 'alert__icon' }), el('div', null, el('p', { class: 'alert__text' }, formMessage)));
          formAlert.hidden = false;
        }
      }
      refresh();
      const bad = ['name', 'name_fr', 'description', 'description_fr'].find((k) => serverErrors[k]);
      if (bad) fieldMap[bad].input.focus();
    }
  });

  return panel.closed.then((v) => v ?? null);
}
