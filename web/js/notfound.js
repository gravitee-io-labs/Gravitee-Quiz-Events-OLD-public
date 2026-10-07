/**
 * 404 page: translates the static markup, wires the language / theme controls. (nginx serves 404.html with status 404.)
 */
import { initTheme } from '/shared/js/theme.js';
import { applyBranding } from '/shared/js/branding.js';
import { hydrateIcons } from '/shared/js/dom.js';
import { i18n, t } from './lib/i18n.js';
import { createAppbar, brandLink, applyUrlOverrides, onLanguage } from './lib/chrome.js';

// A typed or auto-capitalised address such as /World-AI-Summit-2026 is not a dead end: event slugs are always lower case, so go there.
try {
  const { pathname, search, hash } = location;
  const lower = pathname.toLowerCase();
  if (lower !== pathname && /^\/[a-z0-9]+(-[a-z0-9]+)*(\/scoreboard)?\/?$/.test(lower)) location.replace(lower + search + hash);
} catch { /* stay on the 404 page */ }

initTheme();
applyUrlOverrides();
applyBranding(null);

const host = document.getElementById('appbar-host');
const appbar = createAppbar(i18n, { brand: brandLink({ href: '/', name: 'Gravitee Quiz Events' }) });
host.replaceWith(appbar.el);

const render = () => {
  i18n.apply(document);
  document.title = t('notfound.page_title');
  appbar.refresh();
};
hydrateIcons(document);
render();
onLanguage(i18n, render);
