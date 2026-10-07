/**
 * strings.js - EN + FR dictionaries of the buzzer module and the translator the module uses internally.
 *
 * How the strings reach the UI (shared/js/i18n.js has no "extend" API: `createI18n({ dictionaries })` keeps the
 * object it was given and nothing can be added afterwards), so there are two ways, both supported:
 *
 *   1. Host merges them at boot (recommended, lets the host override any wording):
 *        import { mergeBuzzerDictionaries } from './buzzer/index.js';
 *        const i18n = createI18n({ dictionaries: mergeBuzzerDictionaries({ en: {...}, fr: {...} }) });
 *   2. Host does nothing: the controller translates with its own copy of these dictionaries, following `i18n.lang`
 *      and re-rendering on `i18n.onChange`. A key the host defines (`buzzer.*`) always wins over the built-in one.
 *
 * Keys live under the `buzzer` namespace (nested objects, `{placeholders}` as in i18n.t()).
 */

export const buzzerDictionaries = {
  en: {
    buzzer: {
      title: 'Physical buzzers',
      intro: 'Connect your green and red Bluetooth buzzers to answer with real buttons. Taps and the keyboard keep working at all times.',
      button: {
        label: 'Buzzers',
        none: 'none connected',
        count: '{n} of 2 connected',
        both: 'both connected',
        lowBattery: 'battery low',
        reconnecting: 'reconnecting',
        unsupported: 'not available in this browser',
      },
      green: 'Green buzzer',
      red: 'Red buzzer',
      colorName: { green: 'green', red: 'red' },
      state: {
        disconnected: 'Not connected',
        connecting: 'Connecting…',
        connected: 'Connected',
        reconnecting: 'Connection lost. Reconnecting…',
        attempt: 'attempt {n}',
      },
      connect: 'Connect',
      connecting: 'Connecting…',
      disconnect: 'Disconnect',
      stop: 'Stop reconnecting',
      pick: 'A Bluetooth list opens: choose “{name}”.',
      battery: 'Battery {pct}%',
      batteryLow: 'Battery low: {pct}%',
      press: {
        idle: 'Press the buzzer to test it',
        got: 'Press received!',
      },
      keys: {
        lead: 'You can always answer with the keyboard:',
        green: 'green',
        red: 'red',
      },
      test: 'Test LEDs',
      testing: 'Testing…',
      disconnectAll: 'Disconnect all',
      done: 'Done',
      close: 'Close',
      unsupported: {
        title: 'Bluetooth is not available in this browser',
        text: 'Physical buzzers need Web Bluetooth. Use Chrome, Edge or Opera on a computer or an Android phone. You can still play with taps and the keyboard.',
      },
      insecure: {
        title: 'A secure connection is required',
        text: 'Web Bluetooth only works on secure pages (HTTPS). Open the quiz through its https:// address to use physical buzzers.',
      },
      adapter: 'Bluetooth seems to be switched off or unavailable on this device.',
      error: {
        connect: 'Could not connect the {color} buzzer. Check that it is switched on and nearby, then try again.',
        blocked: 'The browser blocked Bluetooth access. Check the site permissions and try again.',
        protocol: 'That device is not a Gravitee quiz buzzer.',
        unknownId: 'This buzzer has an unknown id: re-flash it as green (1) or red (2).',
        taken: 'The {color} buzzer is already connected. Disconnect it first.',
      },
      notice: {
        connected: '{buzzer} connected.',
        assigned: 'That was the {actual} buzzer, so it is connected as {actual}.',
        lost: '{buzzer} disconnected. Reconnecting…',
        reconnected: '{buzzer} reconnected.',
        disconnected: '{buzzer} disconnected.',
        batteryLow: '{buzzer}: battery is low ({pct}%).',
        pressed: '{buzzer} pressed.',
      },
    },
  },
  fr: {
    buzzer: {
      title: 'Buzzers physiques',
      intro: 'Connectez vos buzzers Bluetooth vert et rouge pour répondre avec de vrais boutons. Le toucher et le clavier fonctionnent en permanence.',
      button: {
        label: 'Buzzers',
        none: 'aucun connecté',
        count: '{n} sur 2 connectés',
        both: 'les deux connectés',
        lowBattery: 'batterie faible',
        reconnecting: 'reconnexion en cours',
        unsupported: 'indisponibles dans ce navigateur',
      },
      green: 'Buzzer vert',
      red: 'Buzzer rouge',
      colorName: { green: 'vert', red: 'rouge' },
      state: {
        disconnected: 'Non connecté',
        connecting: 'Connexion…',
        connected: 'Connecté',
        reconnecting: 'Connexion perdue. Reconnexion…',
        attempt: 'tentative {n}',
      },
      connect: 'Connecter',
      connecting: 'Connexion…',
      disconnect: 'Déconnecter',
      stop: 'Arrêter la reconnexion',
      pick: 'Une liste Bluetooth s’ouvre : choisissez « {name} ».',
      battery: 'Batterie {pct} %',
      batteryLow: 'Batterie faible : {pct} %',
      press: {
        idle: 'Appuyez sur le buzzer pour le tester',
        got: 'Appui reçu !',
      },
      keys: {
        lead: 'Vous pouvez toujours répondre au clavier :',
        green: 'vert',
        red: 'rouge',
      },
      test: 'Tester les LED',
      testing: 'Test en cours…',
      disconnectAll: 'Tout déconnecter',
      done: 'Terminé',
      close: 'Fermer',
      unsupported: {
        title: 'Bluetooth n’est pas disponible dans ce navigateur',
        text: 'Les buzzers physiques nécessitent Web Bluetooth. Utilisez Chrome, Edge ou Opera sur ordinateur ou téléphone Android. Vous pouvez toujours jouer au toucher et au clavier.',
      },
      insecure: {
        title: 'Une connexion sécurisée est requise',
        text: 'Web Bluetooth ne fonctionne que sur des pages sécurisées (HTTPS). Ouvrez le quiz via son adresse https:// pour utiliser les buzzers physiques.',
      },
      adapter: 'Le Bluetooth semble désactivé ou indisponible sur cet appareil.',
      error: {
        connect: 'Impossible de connecter le buzzer {color}. Vérifiez qu’il est allumé et à proximité, puis réessayez.',
        blocked: 'Le navigateur a bloqué l’accès au Bluetooth. Vérifiez les autorisations du site puis réessayez.',
        protocol: 'Cet appareil n’est pas un buzzer Gravitee Quiz.',
        unknownId: 'L’identifiant de ce buzzer est inconnu : reflashez-le en vert (1) ou rouge (2).',
        taken: 'Le buzzer {color} est déjà connecté. Déconnectez-le d’abord.',
      },
      notice: {
        connected: '{buzzer} connecté.',
        assigned: 'C’était le buzzer {actual} : il est connecté comme buzzer {actual}.',
        lost: '{buzzer} déconnecté. Reconnexion…',
        reconnected: '{buzzer} reconnecté.',
        disconnected: '{buzzer} déconnecté.',
        batteryLow: '{buzzer} : batterie faible ({pct} %).',
        pressed: '{buzzer} : appui.',
      },
    },
  },
};

const isObject = (v) => v && typeof v === 'object' && !Array.isArray(v);

function deepMerge(base, extra) {
  const out = { ...base };
  for (const [k, v] of Object.entries(extra || {})) out[k] = isObject(v) && isObject(out[k]) ? deepMerge(out[k], v) : v;
  return out;
}

/**
 * Deep-merge the buzzer dictionaries into the host's ones (per language) and return NEW dictionaries.
 * The host's own keys win, so a host can reword any string. Use it before createI18n().
 * @param {Record<string, object>} [hostDictionaries]
 */
export function mergeBuzzerDictionaries(hostDictionaries = {}) {
  const out = { ...hostDictionaries };
  for (const [lang, dict] of Object.entries(buzzerDictionaries)) {
    out[lang] = deepMerge(dict, hostDictionaries[lang] || {});
  }
  return out;
}

const lookup = (dict, path) => path.split('.').reduce((o, k) => (o && typeof o === 'object' ? o[k] : undefined), dict);
const interpolate = (s, params) => (params ? s.replace(/\{(\w+)\}/g, (m, k) => (k in params ? String(params[k]) : m)) : s);

/**
 * Translator bound to an optional i18n instance. t('state.connected') -> 'Connected'.
 * Order: the host's `buzzer.<key>` (when its i18n defines it), then the built-in dictionary for the current
 * language, then English, then the key itself. The language is read on every call, so no state to refresh.
 * @param {{lang?: string, t?: Function, has?: Function}|null} [i18n]
 */
export function createTranslator(i18n) {
  const currentLang = () => String(i18n?.lang || (typeof document !== 'undefined' && document.documentElement.lang) || 'en').toLowerCase().slice(0, 2);
  const t = (key, params) => {
    const full = `buzzer.${key}`;
    try {
      if (i18n && typeof i18n.has === 'function' && i18n.has(full)) return i18n.t(full, params);
    } catch { /* fall through to the built-in strings */ }
    const lang = currentLang();
    const value = lookup(buzzerDictionaries[lang]?.buzzer, key) ?? lookup(buzzerDictionaries.en.buzzer, key);
    return typeof value === 'string' ? interpolate(value, params) : full;
  };
  t.lang = currentLang;
  return t;
}
