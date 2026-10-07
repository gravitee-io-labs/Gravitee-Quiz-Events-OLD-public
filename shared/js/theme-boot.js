/*
 * theme-boot.js - tiny CLASSIC (non-module) script. Put it in <head> before the stylesheets' first paint:
 *   <script src="/shared/js/theme-boot.js"></script>
 * It sets <html data-theme> from ?theme= (this load only), the stored user choice (localStorage "quiz.theme") or the OS, and a default
 * data-bg, so there is no flash of the wrong theme. It is external (CSP: script-src 'self'), never inline.
 * theme.js takes over afterwards.
 */
(function () {
  var root = document.documentElement;
  var theme = 'dark';
  var saved = null;
  try { saved = localStorage.getItem('quiz.theme'); } catch (e) { /* storage blocked */ }
  try { var q = new URLSearchParams(location.search).get('theme'); if (q === 'light' || q === 'dark' || q === 'system') saved = q; } catch (e) { /* ?theme= is this load only, never stored */ }
  try {
    var systemDark = !window.matchMedia || window.matchMedia('(prefers-color-scheme: dark)').matches;
    if (saved === 'light') theme = 'light';
    else if (saved === 'dark') theme = 'dark';
    else if (saved === 'system') theme = systemDark ? 'dark' : 'light';
  } catch (e) { /* keep dark */ }
  root.setAttribute('data-theme', theme);
  if (!root.getAttribute('data-bg')) root.setAttribute('data-bg', 'aurora');
})();
