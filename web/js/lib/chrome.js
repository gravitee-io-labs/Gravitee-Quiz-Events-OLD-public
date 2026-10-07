/**
 * Page chrome shared by the hub, the event page and the 404 page: app bar (brand, language, theme), footer.
 * Built with the design system only (shared/css/components.css: .appbar, .brand, .segmented, .footer).
 */
import { el, icon } from '/shared/js/dom.js';
import { createThemeToggle, setTheme } from '/shared/js/theme.js';

const MARK_SRC = '/shared/img/gravitee-mark.svg';

/** ?theme=light|dark|system on the URL is a one-off, non-persisted override (handy on TVs and for screenshots). */
export function applyUrlOverrides() {
  try {
    const theme = new URLSearchParams(location.search).get('theme');
    if (theme === 'light' || theme === 'dark' || theme === 'system') setTheme(theme, { persist: false });
  } catch { /* no location */ }
}

/**
 * Brand lockup: Gravitee mark, product / game name, optionally the event's own logo.
 * @param {{href?: string, name: string, logoUrl?: string|null, logoAlt?: string}} opts
 */
export function brandLink({ href = '/', name, logoUrl = null, logoAlt = '' }) {
  return el('a', { class: 'brand', href },
    el('img', { class: 'brand__mark', src: MARK_SRC, alt: '', width: 30, height: 30 }),
    el('span', { class: 'brand__name' }, name),
    logoUrl ? el('span', { class: 'brand__sep', 'aria-hidden': 'true' }) : null,
    logoUrl ? el('img', { class: 'brand__event-logo', src: logoUrl, alt: logoAlt, on: { error: (e) => { e.currentTarget.previousElementSibling?.remove(); e.currentTarget.remove(); } } }) : null);
}

/**
 * Two (or more) language radio buttons, e.g. EN | FR. Hidden when only one language is offered.
 * `onPick(code)` decides how the choice is stored (kiosk mode does not persist it).
 */
export function createLangSwitch(i18n, { onPick } = {}) {
  const langs = i18n.supported;
  if (langs.length < 2) return null;
  const name = `lang-${Math.random().toString(36).slice(2, 7)}`;
  const group = el('div', { class: 'segmented segmented--sm lang-switch', role: 'radiogroup', 'aria-label': i18n.t('a11y.language') },
    langs.map((code) => el('label', null,
      el('input', {
        type: 'radio', name, value: code, checked: i18n.lang === code, lang: code,
        'aria-label': i18n.t(`lang.${code}`),
        on: { change: () => (onPick ? onPick(code) : i18n.setLang(code)) },
      }),
      el('span', { 'aria-hidden': 'true' }, code.toUpperCase()))));
  return group;
}

/** Translated labels for the theme toggle. */
export function themeLabels(i18n) {
  return { theme: i18n.t('theme.label'), system: i18n.t('theme.system'), light: i18n.t('theme.light'), dark: i18n.t('theme.dark') };
}

/**
 * The sticky app bar. `slots` are extra nodes (e.g. the buzzer button) shown before the language / theme controls.
 * Call `refresh()` after a language change (labels of the controls are translated at build time).
 */
export function createAppbar(i18n, { brand, onLang } = {}) {
  const brandSlot = el('div', { class: 'appbar__brand' });
  const actions = el('div', { class: 'appbar__actions' });
  const bar = el('header', { class: 'appbar' }, brandSlot, el('span', { class: 'appbar__spacer' }), actions);
  const extras = [];
  const api = {
    el: bar,
    actions,
    setBrand(node) { brandSlot.replaceChildren(node); },
    /** Nodes that stay mounted across refreshes (they are re-appended, never rebuilt). */
    setExtras(nodes) { extras.splice(0, extras.length, ...nodes.filter(Boolean)); api.refresh(); },
    refresh() {
      // the language radios are rebuilt (translated labels): hand the keyboard focus to the new radio with the same value
      const active = document.activeElement;
      const focusedLang = active instanceof HTMLInputElement && active.closest('.lang-switch') ? active.value : null;
      const lang = createLangSwitch(i18n, { onPick: onLang });
      actions.replaceChildren(...extras, ...(lang ? [lang] : []), createThemeToggle({ variant: 'button', labels: themeLabels(i18n) }));
      if (focusedLang) lang?.querySelector(`input[value="${CSS.escape(focusedLang)}"]`)?.focus({ preventScroll: true });
    },
  };
  if (brand) api.setBrand(brand);
  api.refresh();
  return api;
}

/** "Powered by [Gravitee]" + optional link back to the hub. */
export function createFooter(i18n, { hubLink = true } = {}) {
  const f = el('footer', { class: 'footer' });
  const render = () => {
    f.replaceChildren(...[
      el('span', null, i18n.t('common.powered')),
      el('span', { class: 'footer__logo' },
        el('img', { class: 'logo logo--on-dark', src: '/shared/img/gravitee-horizontal-on-dark.svg', alt: 'Gravitee' }),
        el('img', { class: 'logo logo--on-light', src: '/shared/img/gravitee-horizontal-on-light.svg', alt: 'Gravitee' })),
      hubLink ? el('a', { class: 'footer__hub', href: '/' }, icon('squares-four', { size: 'sm' }), i18n.t('common.all_events')) : null,
    ].filter(Boolean));
  };
  render();
  return { el: f, refresh: render };
}

/** Subscribe a refresh function to language changes. */
export function onLanguage(i18n, fn) {
  return i18n.onChange(() => { try { fn(); } catch (e) { console.error(e); } });
}
