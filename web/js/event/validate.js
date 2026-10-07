/**
 * Registration validation (mirrors the backend rules in backend/app/routers/public_events.py + schemas.PlayerCreate,
 * so most mistakes are caught before a round trip). Pure functions: each returns an i18n key under "reg.err." or null.
 */

// No leading / trailing dot or ".." in the local part, no empty domain label, no IP literal: what the API refuses too (found by
// e2e/tests/03b-validation-parity: "john.@example.com" used to pass here and only fail at "Start the game")
const EMAIL_RE = /^(?!\.)(?!.*\.\.)[^\s@]+(?<!\.)@(?!\[)(?:[^\s@.]+\.)+[^\s@.]{2,}$/u;
const PHONE_RE = /^\+?[\d\s().\-/]+$/u;

function name(value) {
  const v = String(value ?? '').trim();
  if (!v) return 'required';
  if (v.includes('@')) return 'name_email';
  if (/[<>]|[\p{Cc}\p{Co}\p{Cs}]/u.test(v)) return 'name_chars'; // the backend refuses markup characters, control, private-use and surrogate characters (names go on the big screen)
  if (!/\p{L}/u.test(v)) return 'name_letters';
  if (v.length > 100) return 'too_long';
  return null;
}

export function validateFirstName(value) {
  const r = name(value);
  return r === 'required' ? 'first_name' : r;
}

export function validateLastName(value) {
  const r = name(value);
  return r === 'required' ? 'last_name' : r;
}

export function validateEmail(value) {
  const v = String(value ?? '').trim();
  if (!v || v.length > 254 || !EMAIL_RE.test(v)) return 'email';
  return null;
}

/** @param {'hidden'|'optional'|'required'} mode */
export function validatePhone(value, mode) {
  if (mode === 'hidden') return null;
  const v = String(value ?? '').trim();
  if (!v) return mode === 'required' ? 'phone_required' : null;
  const digits = v.replace(/\D/g, '').length;
  if (v.length > 20 || !PHONE_RE.test(v) || digits < 6 || digits > 15) return 'phone';
  return null;
}

export function validateConsent(checked, required) {
  return required && !checked ? 'consent' : null;
}

/**
 * Validate the whole form.
 * @returns {Record<string, string>} field -> reg.err key; empty when valid
 */
export function validateForm(form, { phoneMode, consentRequired }) {
  const out = {};
  const set = (field, key) => { if (key) out[field] = key; };
  set('first_name', validateFirstName(form.first_name));
  set('last_name', validateLastName(form.last_name));
  set('email', validateEmail(form.email));
  set('phone_number', validatePhone(form.phone_number, phoneMode));
  set('consent', validateConsent(form.consent, consentRequired));
  return out;
}

/**
 * Map a failed POST /players (ApiError 422 with fieldErrors keyed by backend field names) to {field: reg.err key}.
 */
export function mapServerErrors(fieldErrors = {}) {
  const out = {};
  for (const [field, message] of Object.entries(fieldErrors)) {
    const msg = String(message || '').toLowerCase();
    if (field === 'first_name' || field === 'last_name') out[field] = msg.includes('@') ? 'name_email' : msg.includes('invalid char') ? 'name_chars' : msg.includes('letter') ? 'name_letters' : 'server_field';
    else if (field === 'email') out.email = 'email';
    else if (field === 'phone_number') out.phone_number = msg.includes('required') ? 'phone_required' : 'phone';
    else if (field === 'consent') out.consent = 'consent';
    else if (field === '_' && msg.includes('@')) out.first_name = 'name_email';
    else out[field === '_' ? 'first_name' : field] = 'server_field';
  }
  return out;
}
