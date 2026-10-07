/**
 * core/dialogs.js - the `ctx.confirm()` dialog (optionally "type this text to confirm") built on the design system's openModal.
 */
import { el, uid } from '../../shared/js/dom.js';
import { openModal } from '../../shared/js/ui.js';

/**
 * @param {object} opts
 * @param {string} opts.title
 * @param {string|Node|Array<string|Node>} [opts.message]
 * @param {string} [opts.confirmLabel='Confirm']
 * @param {string} [opts.cancelLabel='Cancel']
 * @param {boolean} [opts.danger=false]  red confirm button, focus starts on the safe choice
 * @param {string} [opts.requireText]    the user must type exactly this text before the confirm button unlocks
 * @param {string} [opts.requireLabel]   label of that field
 * @param {Node} [opts.details]          extra node under the message (e.g. what will be lost)
 * @param {string} [opts.icon]
 * @returns {Promise<boolean>}
 */
export function confirmDialog({ title = 'Are you sure?', message, confirmLabel = 'Confirm', cancelLabel = 'Cancel', danger = false, requireText, requireLabel, details, icon: iconName } = {}) {
  const messages = (Array.isArray(message) ? message : [message]).filter(Boolean).map((m) => (typeof m === 'string' ? el('p', { class: 'u-muted' }, m) : m));
  let input = null;
  let field = null;
  if (requireText) {
    const id = uid('confirm-text');
    input = el('input', { class: 'input input--mono', id, type: 'text', autocomplete: 'off', autocapitalize: 'off', spellcheck: 'false', 'aria-describedby': `${id}-help` });
    field = el('div', { class: 'field' },
      el('label', { class: 'field__label', for: id }, requireLabel || `Type ${requireText} to confirm`),
      input,
      el('p', { class: 'field__help', id: `${id}-help` }, 'This cannot be undone.'));
  }
  const content = el('div', { class: 'stack' }, ...messages, details || null, field);
  const modal = openModal({
    title, content, size: 'sm', danger, icon: iconName || (danger ? 'warning' : 'question'),
    actions: [
      { label: cancelLabel, variant: 'secondary', value: false },
      { label: confirmLabel, variant: danger ? 'danger' : 'primary', value: true, autofocus: !danger && !requireText },
    ],
  });
  const [cancelBtn, okBtn] = modal.dialog.querySelectorAll('.dialog__footer .btn');
  if (input) {
    okBtn.disabled = true;
    const sync = () => { okBtn.disabled = input.value.trim() !== requireText; };
    input.addEventListener('input', sync);
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); if (!okBtn.disabled) okBtn.click(); } });
    input.focus();
  } else if (danger) {
    cancelBtn?.focus();
  }
  return modal.closed.then((v) => v === true);
}

/** "You have unsaved changes" prompt used by the dirty-form guard. */
export function confirmLeave() {
  return confirmDialog({
    title: 'Leave without saving?',
    message: 'You have unsaved changes on this page. If you leave now they will be lost.',
    confirmLabel: 'Discard changes',
    cancelLabel: 'Keep editing',
    danger: true,
    icon: 'warning',
  });
}
