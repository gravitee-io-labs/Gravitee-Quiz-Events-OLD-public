/**
 * The app-wide i18n instance (EN + FR dictionaries in strings.js).
 * Language resolution: ?lang= -> localStorage "quiz.lang" -> event default -> browser -> en (see shared/js/i18n.js).
 */
import { createI18n } from '/shared/js/i18n.js';
import { en, fr } from './strings.js';

export const i18n = createI18n({ dictionaries: { en, fr }, fallback: 'en' });
export const t = (key, params) => i18n.t(key, params);
