/**
 * Registration: first name, last name, email, phone (hidden / optional / required per event) and a consent checkbox
 * when the event has a consent text in the current language.
 *
 * Values live in ctx.state.form (memory only, never localStorage / sessionStorage). Validation is inline, in the
 * current language; server-side errors (props.serverErrors) are shown on the same fields.
 */
import { el, icon, uid } from '/shared/js/dom.js';
import { announce } from '/shared/js/ui.js';
import { validateFirstName, validateLastName, validateEmail, validatePhone, validateConsent, validateForm } from '../validate.js';

export function registerView(ctx, props = {}) {
  const { event, i18n, t, state, kiosk } = ctx;
  const form = state.form;
  const phoneMode = event.settings?.collect_phone || 'optional';
  // the backend requires consent as soon as ANY language has a consent text: never hide the box because only the other language has one
  const consentSettings = event.settings || {};
  const consentText = String(i18n.pick(consentSettings, 'consent_text') || consentSettings.consent_text_en || consentSettings.consent_text_fr || '').trim();
  const touched = new Set();
  const errors = { ...(props.serverErrors || {}) };
  Object.keys(errors).forEach((f) => touched.add(f));
  const fromServer = new Set(Object.keys(errors)); // stays flagged until the player edits that field

  const ids = { first_name: uid('first'), last_name: uid('last'), email: uid('email'), phone_number: uid('phone'), consent: uid('consent') };
  const errEls = {};
  const inputs = {};
  const auto = (token) => (kiosk ? 'off' : token); // shared booth laptop: never suggest the previous player's details

  function validators() {
    return {
      first_name: () => validateFirstName(form.first_name),
      last_name: () => validateLastName(form.last_name),
      email: () => validateEmail(form.email),
      phone_number: () => validatePhone(form.phone_number, phoneMode),
      consent: () => validateConsent(form.consent, !!consentText),
    };
  }

  function showError(field, key) {
    const fieldEl = inputs[field]?.closest('.field');
    const errEl = errEls[field];
    if (!fieldEl || !errEl) return;
    if (key) {
      errEl.replaceChildren(icon('warning-circle', { size: 'sm' }), el('span', null, t(`reg.err.${key}`)));
      errEl.hidden = false;
      fieldEl.classList.add('field--invalid');
      inputs[field].setAttribute('aria-invalid', 'true');
    } else {
      errEl.replaceChildren();
      errEl.hidden = true;
      fieldEl.classList.remove('field--invalid');
      inputs[field].removeAttribute('aria-invalid');
    }
    errors[field] = key || undefined;
    if (!key) delete errors[field];
  }

  function field(name, { label, type = 'text', autocomplete, inputmode, optional, maxlength, full }) {
    const id = ids[name];
    const errId = `${id}-err`;
    const input = el('input', {
      class: 'input input--lg', id, name, type, autocomplete: auto(autocomplete), inputmode, maxlength,
      enterkeyhint: name === 'phone_number' || (name === 'email' && phoneMode === 'hidden') ? 'go' : 'next',
      required: !optional, 'aria-describedby': errId,
      autocapitalize: name === 'email' ? 'none' : 'words', autocorrect: 'off', spellcheck: 'false',
      value: form[name] ?? '',
      on: {
        input: (e) => {
          form[name] = e.currentTarget.value;
          fromServer.delete(name);
          if (touched.has(name)) showError(name, validators()[name]());
        },
        blur: () => {
          if (fromServer.has(name)) return;
          if (String(form[name] ?? '').trim() || touched.has(name)) { touched.add(name); showError(name, validators()[name]()); }
        },
      },
    });
    inputs[name] = input;
    const errEl = el('p', { class: 'field__error', id: errId, hidden: true });
    errEls[name] = errEl;
    return el('div', { class: ['field', full && 'field--full'] },
      el('label', { class: 'field__label', for: id },
        el('span', null, label),
        optional ? el('span', { class: 'field__optional' }, t('common.optional')) : null),
      input, errEl);
  }

  const grid = el('div', { class: 'form-grid ev-form-grid' },
    field('first_name', { label: t('reg.first_name'), autocomplete: 'given-name', maxlength: 100 }),
    field('last_name', { label: t('reg.last_name'), autocomplete: 'family-name', maxlength: 100 }),
    field('email', { label: t('reg.email'), type: 'email', autocomplete: 'email', inputmode: 'email', maxlength: 254, full: true }),
    phoneMode === 'hidden' ? null : field('phone_number', { label: t('reg.phone'), type: 'tel', autocomplete: 'tel', inputmode: 'tel', maxlength: 20, optional: phoneMode === 'optional', full: true }));

  let consentBox = null;
  if (consentText) {
    const errId = `${ids.consent}-err`;
    consentBox = el('input', {
      type: 'checkbox', class: 'checkbox', id: ids.consent, name: 'consent', required: true, checked: !!form.consent, 'aria-describedby': errId,
      on: { change: (e) => { form.consent = e.currentTarget.checked; fromServer.delete('consent'); if (touched.has('consent') || form.consent) showError('consent', validators().consent()); } },
    });
    inputs.consent = consentBox;
    errEls.consent = el('p', { class: 'field__error', id: errId, hidden: true });
    grid.append(el('div', { class: 'field field--full ev-consent' },
      el('label', { class: 'check', for: ids.consent }, consentBox, el('span', { class: 'check__text' }, consentText)),
      errEls.consent));
  }


  const submit = (e) => {
    e.preventDefault();
    const found = validateForm(form, { phoneMode, consentRequired: !!consentText });
    fromServer.clear();
    Object.keys(inputs).forEach((f) => { touched.add(f); showError(f, found[f] || null); });
    const first = Object.keys(inputs).find((f) => found[f]);
    if (first) {
      inputs[first].focus();
      announce(t('reg.err.summary'), { politeness: 'assertive' });
      return;
    }
    form.first_name = form.first_name.trim();
    form.last_name = form.last_name.trim();
    form.email = form.email.trim();
    form.phone_number = (form.phone_number || '').trim();
    ctx.go('rules');
  };

  const formEl = el('form', { class: 'ev-form glass u-rise', novalidate: true, autocomplete: kiosk ? 'off' : 'on', on: { submit } },
    grid,
    el('p', { class: 'ev-privacy' }, icon('lock-key', { size: 'sm' }), el('span', null, t('reg.privacy'))),
    el('div', { class: 'form-actions ev-form-actions' },
      el('button', { type: 'button', class: 'btn btn--ghost btn--lg', on: { click: () => ctx.back('landing') } }, icon('arrow-left'), t('reg.back')),
      el('button', { type: 'submit', class: 'btn btn--primary btn--lg ev-submit' }, t('reg.submit'), icon('arrow-right'))));

  const root = el('div', { class: 'ev-register' },
    el('header', { class: 'ev-head' },
      el('h1', { class: 'ev-title', tabindex: '-1' }, t('reg.title')),
      el('p', { class: 'ev-sub' }, t('reg.subtitle'))),
    formEl);

  // errors passed in (server side) or kept across a language switch
  Object.entries(errors).forEach(([f, key]) => showError(f, key));

  const firstServerError = Object.keys(inputs).find((f) => fromServer.has(f) && errors[f]);
  return {
    el: root,
    // with server-side errors the focus goes straight to the first flagged field
    focusEl: firstServerError ? inputs[firstServerError] : root.querySelector('.ev-title'),
    // a language switch re-renders the view: the errors on screen (client or server side) are handed to the new instance
    state: () => ({ serverErrors: { ...errors } }),
  };
}
