/**
 * Event factory: builds a deterministic event bundle and imports it through the admin API.
 *
 * Question model (so tests can assert without guessing):
 *   - every question is "QA statement N: water is wet." (FR "Affirmation QA N : l'eau est mouillee.");
 *   - the correct answer is ALWAYS green (TRUE / "Alpha N") so pressing G is right and R is wrong, whatever the draw order;
 *   - each question has an English and a French explanation: "Explanation N: ..." / "Explication N : ...";
 *   - two categories ("QA Alpha" / "QA Beta", with French names) share the questions;
 *   - the first `twoChoices` questions use the two_choices format with the labels "Alpha N" / "Omega N".
 */
import { admin, SLUG_PREFIX } from './api';

export interface EventSpec {
  /** short human tag, used in the generated slug ("hub-live" -> qa-e2e-ab12-hub-live-x9z) */
  tag?: string;
  slug?: string;
  name?: string;
  gameTitle?: string;
  status?: 'draft' | 'live' | 'closed';
  /** how many questions the pool holds (default 20) */
  questions?: number;
  /** how many of them are two_choices (default 0) */
  twoChoices?: number;
  /** questions per game (default 15; never more than `questions`) */
  perGame?: number;
  timer?: number;
  pointsCorrect?: number;
  timeBonusMax?: number;
  collectPhone?: 'hidden' | 'optional' | 'required';
  consentEn?: string | null;
  consentFr?: string | null;
  languages?: string[];
  defaultLanguage?: string;
  location?: string | null;
  startsOn?: string | null;
  endsOn?: string | null;
  primary?: string;
  accent?: string;
  background?: 'aurora' | 'grid' | 'plain';
  theme?: 'dark' | 'light' | 'system';
  /** extra keys merged into bundle.event (hero_title_en, tagline_en, description_fr...) */
  event?: Record<string, unknown>;
  /** replace the generated questions / categories entirely */
  categories?: any[];
  questionList?: any[];
}

export interface TestEvent {
  id: number;
  slug: string;
  name: string;
  gameTitle: string;
  raw: any;
}

let counter = 0;
const rand = () => Math.random().toString(36).slice(2, 6);
export const runId = () => process.env.E2E_RUN_ID || 'local';

/** "qa-e2e-<run>-<tag>-<rand>": unique, valid slug (2-48 chars), recognisable by the sweeper. */
export function uniqueSlug(tag = 'ev') {
  const clean = tag.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 18) || 'ev';
  return `${SLUG_PREFIX}${runId()}-${clean}-${rand()}${(counter++).toString(36)}`.slice(0, 48);
}

export function questionBundle(n: number, spec: EventSpec = {}) {
  const twoChoices = Math.min(spec.twoChoices ?? 0, n);
  const out: any[] = [];
  for (let i = 1; i <= n; i += 1) {
    const two = i <= twoChoices;
    out.push({
      category: i % 2 ? 'QA Alpha' : 'QA Beta',
      question_format: two ? 'two_choices' : 'true_false',
      difficulty: ((i - 1) % 3) + 1,
      question_text_en: `QA statement ${i}: water is wet.`,
      question_text_fr: `Affirmation QA ${i} : l'eau est mouillée.`,
      correct_answer: 'green',
      ...(two ? { green_label_en: `Alpha ${i}`, green_label_fr: `Alfa ${i}`, red_label_en: `Omega ${i}`, red_label_fr: `Oméga ${i}` } : {}),
      explanation_en: `Explanation ${i}: water is indeed wet.`,
      explanation_fr: `Explication ${i} : l'eau est bien mouillée.`,
      is_active: true,
    });
  }
  return out;
}

export function buildBundle(spec: EventSpec = {}) {
  const slug = spec.slug || uniqueSlug(spec.tag);
  const n = spec.questions ?? 20;
  const perGame = Math.min(spec.perGame ?? 15, Math.max(n, 1));
  const name = spec.name ?? `QA ${spec.tag || 'Event'} ${slug.slice(-6)}`;
  const gameTitle = spec.gameTitle ?? 'QA Masters';
  return {
    format: 'gravitee-quiz-event',
    version: 1,
    event: {
      slug,
      name,
      game_title: gameTitle,
      status: spec.status ?? 'live',
      location: spec.location === undefined ? 'Amsterdam' : spec.location,
      starts_on: spec.startsOn === undefined ? '2026-10-07' : spec.startsOn,
      ends_on: spec.endsOn === undefined ? '2026-10-08' : spec.endsOn,
      languages: spec.languages ?? ['en', 'fr'],
      default_language: spec.defaultLanguage ?? 'en',
      tagline_en: `Tagline of ${name}`,
      tagline_fr: `Accroche de ${name}`,
      description_en: `Description of ${name}.`,
      description_fr: `Description de ${name}.`,
      branding: {
        primary_color: spec.primary ?? '#7C5CFF',
        accent_color: spec.accent ?? '#22D3EE',
        background_style: spec.background ?? 'aurora',
        logo_url: null,
        default_theme: spec.theme ?? 'dark',
      },
      settings: {
        questions_per_game: perGame,
        timer_seconds: spec.timer ?? 5,
        points_correct: spec.pointsCorrect ?? 100,
        points_wrong: 0,
        time_bonus_max: spec.timeBonusMax ?? 50,
        question_order: 'random',
        collect_phone: spec.collectPhone ?? 'optional',
        consent_text_en: spec.consentEn ?? null,
        consent_text_fr: spec.consentFr ?? null,
        category_distribution: null,
      },
      ...(spec.event || {}),
    },
    categories: spec.categories ?? [
      { name: 'QA Alpha', name_fr: 'QA Alfa', description: 'Alpha questions', description_fr: 'Questions alfa', color: '#7C5CFF', is_active: true },
      { name: 'QA Beta', name_fr: 'QA Bêta', description: 'Beta questions', description_fr: 'Questions bêta', color: '#16A34A', is_active: true },
    ],
    questions: spec.questionList ?? questionBundle(n, spec),
  };
}

/** Create an event (draft / live / closed) through POST /admin/events/import. */
export async function createEvent(spec: EventSpec = {}): Promise<TestEvent> {
  const bundle = buildBundle(spec);
  const raw = await admin.post('/admin/events/import', { bundle, slug: bundle.event.slug, name: bundle.event.name, status: bundle.event.status });
  return { id: raw.id, slug: raw.slug, name: raw.name, gameTitle: raw.game_title, raw };
}

/** A bare event with no categories / questions at all (what the admin "New event > Blank" flow produces). */
export async function createMinimalEvent(spec: Pick<EventSpec, 'tag' | 'slug' | 'name' | 'gameTitle' | 'status'> = {}): Promise<TestEvent> {
  const slug = spec.slug || uniqueSlug(spec.tag || 'min');
  const raw = await admin.post('/admin/events', {
    slug,
    name: spec.name ?? `QA minimal ${slug.slice(-6)}`,
    game_title: spec.gameTitle ?? 'QA Masters',
    status: spec.status ?? 'draft',
  });
  return { id: raw.id, slug: raw.slug, name: raw.name, gameTitle: raw.game_title, raw };
}

export const setStatus = (ev: TestEvent, status: 'draft' | 'live' | 'closed') => admin.put(`/admin/events/${ev.id}`, { status });
export const getAdminEvent = (ev: TestEvent | number) => admin.get(`/admin/events/${typeof ev === 'number' ? ev : ev.id}`);
