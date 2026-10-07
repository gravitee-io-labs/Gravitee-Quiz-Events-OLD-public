/**
 * i18n.js - small, dependency-free i18n for en/fr (any list of languages works).
 *
 *   const i18n = createI18n({ dictionaries: { en: {...}, fr: {...} }, fallback: 'en' });
 *   i18n.setSupported(event.languages); i18n.setEventDefault(event.default_language);
 *   i18n.t('game.question', {n: 3});  i18n.pick(category, 'name');  i18n.apply(document);
 *
 * Language resolution order (ARCHITECTURE section 7): ?lang= -> localStorage "quiz.lang" -> event default -> browser -> fallback.
 * Only languages in `supported` can win.
 */
import { formatNumber, formatPercent, formatDate, formatDateTime, formatDateRange, relativeTime } from './dom.js';

const LS_KEY = 'quiz.lang';

const mem = {};   // choices kept in memory too, for browsers where localStorage is blocked
const store = {
  get(key) { try { return localStorage.getItem(key); } catch { return mem[key] ?? null; } },
  set(key, value) { mem[key] = value; try { localStorage.setItem(key, value); } catch { /* storage blocked: memory only */ } },
};

/** 'fr-FR' -> 'fr' */
const base = (code) => String(code || '').toLowerCase().split(/[-_]/)[0];

function lookup(dict, key) {
  if (!dict) return undefined;
  if (Object.prototype.hasOwnProperty.call(dict, key)) return dict[key];
  let cur = dict;
  for (const part of key.split('.')) {
    if (cur && typeof cur === 'object' && Object.prototype.hasOwnProperty.call(cur, part)) cur = cur[part]; else return undefined;
  }
  return cur;
}

/**
 * @param {object} opts
 * @param {Record<string, object>} opts.dictionaries { en: {nav: {play: 'Play'}}, fr: {...} } (nested or flat 'nav.play' keys)
 * @param {string} [opts.fallback='en']
 * @param {string[]} [opts.supported] default: Object.keys(dictionaries)
 * @param {string} [opts.eventDefault] language the event prefers
 * @param {string} [opts.storageKey='quiz.lang']
 * @param {boolean} [opts.autoApply=true] re-run apply(document) on language change
 */
export function createI18n({ dictionaries = {}, fallback = 'en', supported, eventDefault = null, storageKey = LS_KEY, autoApply = true } = {}) {
  let sup = (supported || Object.keys(dictionaries)).map(base);
  let evDefault = eventDefault ? base(eventDefault) : null;
  let lang = fallback;
  const listeners = new Set();

  function resolve() {
    const ok = (c) => { const b = base(c); return sup.includes(b) ? b : null; };
    let fromUrl = null;
    try { fromUrl = ok(new URLSearchParams(location.search).get('lang')); } catch { /* no location */ }
    const stored = ok(store.get(storageKey));
    const browser = (typeof navigator !== 'undefined' ? [...(navigator.languages || []), navigator.language] : []).map(ok).find(Boolean) || null;
    return fromUrl || stored || ok(evDefault) || browser || (sup.includes(base(fallback)) ? base(fallback) : sup[0]) || 'en';
  }

  function commit(next, { notify = true } = {}) {
    const changed = next !== lang;
    lang = next;
    if (typeof document !== 'undefined') document.documentElement.lang = lang;
    if (changed || notify) {
      if (autoApply && typeof document !== 'undefined') api.apply(document);
      if (changed) listeners.forEach((cb) => { try { cb(lang); } catch (e) { console.error(e); } });
    }
  }

  const api = {
    /** current language code */
    get lang() { return lang; },
    /** languages the UI can show */
    get supported() { return [...sup]; },
    /** Translate. Falls back to the fallback language, then to the key. {name} placeholders; `count` selects key_one/key_other plural forms. */
    t(key, params) {
      let value;
      if (params && typeof params.count === 'number') {
        const rule = new Intl.PluralRules(lang).select(params.count);
        value = lookup(dictionaries[lang], `${key}_${rule}`) ?? lookup(dictionaries[fallback], `${key}_${rule}`)
          ?? lookup(dictionaries[lang], `${key}_other`) ?? lookup(dictionaries[fallback], `${key}_other`);
      }
      value ??= lookup(dictionaries[lang], key) ?? lookup(dictionaries[fallback], key);
      if (typeof value !== 'string') return key;
      return params ? value.replace(/\{(\w+)\}/g, (m, k) => (k in params ? String(params[k]) : m)) : value;
    },
    /** True if the key exists in the current or fallback dictionary. */
    has(key) { return typeof (lookup(dictionaries[lang], key) ?? lookup(dictionaries[fallback], key)) === 'string'; },
    /** Change language (persisted as the user's choice unless persist:false). */
    setLang(next, { persist = true } = {}) {
      const b = base(next);
      if (!sup.includes(b)) return lang;
      if (persist) store.set(storageKey, b);
      commit(b);
      return lang;
    },
    /** Languages offered by the event (['en','fr']); re-resolves the current language. */
    setSupported(list) {
      const next = (list || []).map(base).filter(Boolean);
      if (next.length) { sup = next; commit(resolve(), { notify: false }); }
      return api;
    },
    /** The event's default language (used when the user has not chosen and no ?lang= is present). */
    setEventDefault(code) { evDefault = code ? base(code) : null; commit(resolve(), { notify: false }); return api; },
    /** Re-resolve from URL/storage/event/browser. */
    resolve() { commit(resolve()); return lang; },
    /**
     * Pick a translated content field: pick(cat,'name') -> name_fr (when lang=fr and non-empty), else name_en, else name.
     * Works for 'name'/'name_fr' (categories) and 'tagline_en'/'tagline_fr' (events) alike.
     */
    pick(obj, field, forLang = lang) {
      if (!obj) return '';
      const candidates = [];
      if (forLang) candidates.push(`${field}_${forLang}`);
      candidates.push(field, `${field}_en`, `${field}_${base(fallback)}`);
      for (const c of candidates) { const v = obj[c]; if (typeof v === 'string' && v.trim() !== '') return v; }
      return '';
    },
    /** Subscribe to language changes; returns unsubscribe. */
    onChange(cb) { listeners.add(cb); return () => listeners.delete(cb); },
    /**
     * Apply translations to static markup under `root`:
     *   data-i18n="key"                       -> textContent
     *   data-i18n-attr="placeholder:key; aria-label:key2"  -> attributes
     *   data-i18n-params='{"n":3}'            -> interpolation values (JSON)
     */
    apply(root = document) {
      const paramsOf = (node) => { try { return node.dataset.i18nParams ? JSON.parse(node.dataset.i18nParams) : undefined; } catch { return undefined; } };
      root.querySelectorAll('[data-i18n]').forEach((node) => { node.textContent = api.t(node.dataset.i18n, paramsOf(node)); });
      root.querySelectorAll('[data-i18n-attr]').forEach((node) => {
        for (const pair of node.dataset.i18nAttr.split(';')) {
          const [attr, key] = pair.split(':').map((s) => s.trim());
          if (attr && key) node.setAttribute(attr, api.t(key, paramsOf(node)));
        }
      });
      return root;
    },
    // Intl helpers bound to the current language
    number: (n, opts) => formatNumber(n, { lang, ...opts }),
    percent: (r, opts) => formatPercent(r, { lang, ...opts }),
    date: (d, opts) => formatDate(d, { lang, ...opts }),
    dateTime: (d, opts) => formatDateTime(d, { lang, ...opts }),
    relative: (d) => relativeTime(d, lang),
    list: (items, type = 'conjunction') => new Intl.ListFormat(lang, { style: 'long', type }).format(items),
    /** '7 Oct 2026' / '7–8 Oct 2026' / '30 Sep – 2 Oct 2026' (date-only strings keep their calendar day in every time zone) */
    dateRange: (a, b) => formatDateRange(a, b, { lang }),
  };

  commit(resolve(), { notify: false });
  return api;
}
