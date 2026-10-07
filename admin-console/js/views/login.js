/**
 * Login screen: branded card, inline error, throttle (429) countdown, show/hide password.
 * ctx (login scope): { api, toast, navigate, loggedIn(username) }
 */
import { el, icon, uid } from '../../shared/js/dom.js';
import { apiUrl, setToken } from '../../shared/js/api.js';
import { createThemeToggle } from '../../shared/js/theme.js';
import { shake } from '../../shared/js/effects.js';
import { announce } from '../../shared/js/ui.js';

const IMG = (name) => new URL(`../../shared/img/${name}`, import.meta.url).href;
const mmss = (s) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;

export default {
  id: 'login',
  title: 'Sign in',
  icon: 'sign-in',

  async mount(root, ctx) {
    const ids = { user: uid('login-user'), pass: uid('login-pass'), err: uid('login-err') };
    let timer = null;
    let busy = false;
    let lockedUntil = 0;

    const username = el('input', { class: 'input input--lg', id: ids.user, name: 'username', type: 'text', autocomplete: 'username', autocapitalize: 'off', spellcheck: 'false', required: true, enterkeyhint: 'next' });
    const password = el('input', { class: 'input input--lg', id: ids.pass, name: 'password', type: 'password', autocomplete: 'current-password', required: true, enterkeyhint: 'go' });
    const reveal = el('button', {
      type: 'button', class: 'btn btn--ghost btn--icon btn--sm pass-wrap__btn', 'aria-label': 'Show password', 'aria-pressed': 'false',
      on: { click: () => {
        const show = password.type === 'password';
        password.type = show ? 'text' : 'password';
        reveal.setAttribute('aria-pressed', String(show));
        reveal.setAttribute('aria-label', show ? 'Hide password' : 'Show password');
        reveal.replaceChildren(icon(show ? 'eye-slash' : 'eye'));
      } },
    }, icon('eye'));

    const errBox = el('div', { class: 'alert alert--danger login__alert', id: ids.err, role: 'alert', hidden: true });
    const submit = el('button', { type: 'submit', class: 'btn btn--primary btn--lg btn--block' }, icon('sign-in'), el('span', { class: 'login__submit-label' }, 'Sign in'));
    const label = submit.querySelector('.login__submit-label');

    const showError = (message, { title } = {}) => {
      errBox.replaceChildren(icon('warning-fill', { class: 'alert__icon' }), el('div', null, title ? el('p', { class: 'alert__title' }, title) : null, el('p', title ? { class: 'alert__text' } : { class: 'alert__title' }, message)));
      errBox.hidden = false;
      username.setAttribute('aria-describedby', ids.err); password.setAttribute('aria-describedby', ids.err);
    };
    const clearError = () => { errBox.hidden = true; errBox.replaceChildren(); username.removeAttribute('aria-describedby'); password.removeAttribute('aria-describedby'); username.removeAttribute('aria-invalid'); password.removeAttribute('aria-invalid'); };

    function setBusy(on) {
      busy = on;
      submit.classList.toggle('is-loading', on);
      submit.toggleAttribute('aria-busy', on);
      submit.disabled = on || Date.now() < lockedUntil;
      username.readOnly = on; password.readOnly = on;
    }

    function lock(seconds) {
      lockedUntil = Date.now() + seconds * 1000;
      clearInterval(timer);
      const tick = () => {
        const left = Math.max(0, Math.ceil((lockedUntil - Date.now()) / 1000));
        if (left <= 0) {
          clearInterval(timer); label.textContent = 'Sign in'; submit.disabled = false; clearError();
          announce('You can try signing in again.');
          return;
        }
        label.textContent = `Try again in ${mmss(left)}`;
        submit.disabled = true;
      };
      tick();
      timer = setInterval(tick, 1000);
    }

    async function signIn(e) {
      e.preventDefault();
      if (busy || Date.now() < lockedUntil) return;
      clearError();
      const u = username.value.trim(), p = password.value;
      if (!u || !p) {
        showError(!u ? 'Enter your username.' : 'Enter your password.');
        (!u ? username : password).setAttribute('aria-invalid', 'true');
        (!u ? username : password).focus();
        return;
      }
      setBusy(true);
      try {
        let res;
        try {
          res = await fetch(apiUrl('/auth/login'), {
            method: 'POST', credentials: 'same-origin',
            headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
            body: JSON.stringify({ username: u, password: p }),
          });
        } catch {
          showError('Cannot reach the server. Check your connection and try again.', { title: 'Network error' });
          return;
        }
        const body = await res.json().catch(() => null);
        if (res.ok && body?.access_token) {
          setToken(body.access_token);
          password.value = '';
          ctx.loggedIn(u);
          return;
        }
        if (res.status === 429) {
          const wait = Math.min(900, Math.max(5, Number(res.headers.get('Retry-After')) || 300));
          showError(`Too many failed attempts. For your security sign-in is paused for ${Math.ceil(wait / 60)} minute${wait > 90 ? 's' : ''}.`, { title: 'Please wait a moment' });
          password.value = '';
          lock(wait);
          return;
        }
        if (res.status === 401 || res.status === 400 || res.status === 422) {
          showError('Incorrect username or password.', { title: 'Sign-in failed' });
          username.setAttribute('aria-invalid', 'true'); password.setAttribute('aria-invalid', 'true');
          password.value = ''; password.focus();
          shake(card);
          return;
        }
        showError(typeof body?.detail === 'string' ? body.detail : `The server answered ${res.status}. Try again in a moment.`, { title: 'Sign-in unavailable' });
      } finally {
        setBusy(false);
        if (Date.now() < lockedUntil) submit.disabled = true;
      }
    }

    const form = el('form', { class: 'stack login__form', novalidate: true, on: { submit: signIn } },
      errBox,
      el('div', { class: 'field' }, el('label', { class: 'field__label', for: ids.user }, 'Username'), username),
      el('div', { class: 'field' }, el('label', { class: 'field__label', for: ids.pass }, 'Password'), el('div', { class: 'pass-wrap' }, password, reveal)),
      submit);

    const card = el('section', { class: 'login__card glass glass--strong', 'aria-labelledby': 'login-title' },
      el('div', { class: 'login__logo' },
        el('img', { class: 'logo logo--lg logo--on-dark', src: IMG('gravitee-horizontal-on-dark.svg'), alt: 'Gravitee' }),
        el('img', { class: 'logo logo--lg logo--on-light', src: IMG('gravitee-horizontal-on-light.svg'), alt: 'Gravitee' })),
      el('div', { class: 'login__head' },
        el('h1', { class: 'login__title', id: 'login-title' }, 'Quiz Admin'),
        el('p', { class: 'u-muted' }, 'Sign in to manage your events, questions and results.')),
      form);

    root.replaceChildren(el('div', { class: 'login' },
      el('div', { class: 'login__top' }, createThemeToggle({ variant: 'button', labels: { theme: 'Theme' } })),
      el('main', { class: 'login__main', id: 'main' }, card),
      el('footer', { class: 'login__foot' }, el('img', { class: 'login__mark', src: IMG('gravitee-mark.svg'), alt: '', width: 18, height: 18 }), el('span', null, 'Powered by Gravitee'))));

    setTimeout(() => username.focus(), 30);

    return {
      unmount() { clearInterval(timer); },
    };
  },
};
