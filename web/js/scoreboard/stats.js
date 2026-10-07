/**
 * stats.js - the "statistics" panel shown by ?rotate=1 between two passes of the leaderboard:
 * four big tiles (players, games, top score, best round), the game rules in one line, the categories.
 */
import { el, icon } from '/shared/js/dom.js';
import { countUp, prefersReducedMotion } from '/shared/js/effects.js';
import { countFormat } from './format.js';
import { safeColor } from '../lib/format.js';

const TILES = [
  { key: 'players', icon: 'users-three', label: 'stats.players' },
  { key: 'games', icon: 'flag-checkered', label: 'stats.games' },
  { key: 'top', icon: 'trophy', label: 'stats.top' },
  { key: 'accuracy', icon: 'target', label: 'stats.accuracy' },
];

export function createStatsView({ tilesEl, rulesEl, catsEl, i18n }) {
  const t = (k, p) => i18n.t(k, p);
  const nf = (n) => i18n.number(n);
  const tiles = TILES.map((def) => {
    const label = el('span', { class: 'sb-tile__label' });
    const value = el('span', { class: 'sb-tile__value' }, '–');
    const sub = el('span', { class: 'sb-tile__sub' });
    const root = el('div', { class: `sb-tile sb-tile--${def.key}` },
      el('span', { class: 'sb-tile__icon', 'aria-hidden': 'true' }, icon(def.icon)),
      label, value, sub);
    return { def, root, label, value, sub, to: null };
  });
  tilesEl.replaceChildren(...tiles.map((x) => x.root));

  let model = { players: 0, games: 0, entries: [], event: null };
  let anim = [];

  function valueFor(tile) {
    const { entries, event } = model;
    const total = event?.settings?.questions_per_game ?? 0;
    switch (tile.def.key) {
      case 'players': return { n: model.players, text: nf(model.players), sub: '' };
      case 'games': return { n: model.games, text: nf(model.games), sub: '' };
      case 'top': {
        const top = entries[0];
        return top ? { n: top.score, text: nf(top.score), sub: t('stats.top_sub', { name: top.player_name }) } : { n: null, text: '–', sub: '' };
      }
      default: {
        const best = entries.reduce((a, e) => (!a || e.correct_answers > a.correct_answers ? e : a), null);
        return best
          ? { n: null, text: total ? `${best.correct_answers}/${total}` : String(best.correct_answers), sub: t('stats.top_sub', { name: best.player_name }) }
          : { n: null, text: '–', sub: '' };
      }
    }
  }

  /** Re-render texts from the latest model (language change, new data). `animateNumbers` counts up the big numbers. */
  function render({ animateNumbers = false } = {}) {
    for (const a of anim) a.cancel();
    anim = [];
    // one font size for the four tiles (the widest number decides), so the labels line up across a row
    tilesEl.style.setProperty('--chars', String(Math.max(2, ...tiles.map((tile) => valueFor(tile).text.length))));
    for (const tile of tiles) {
      const v = valueFor(tile);
      tile.label.textContent = t(tile.def.label);
      tile.sub.textContent = v.sub;
      if (animateNumbers && v.n !== null && !prefersReducedMotion()) {
        anim.push(countUp(tile.value, v.n, { from: 0, duration: 1400, format: countFormat(nf) }));
      } else tile.value.textContent = v.text;
    }
    const s = model.event?.settings;
    if (s) {
      const max = s.questions_per_game * (s.points_correct + s.time_bonus_max);
      rulesEl.replaceChildren(
        el('span', { class: 'sb-rule' }, icon('list-checks'), t('stats.rules', { count: s.questions_per_game })),
        el('span', { class: 'sb-rule' }, icon('timer'), t('stats.rules_time', { s: s.timer_seconds })),
        el('span', { class: 'sb-rule' }, icon('lightning'), t('stats.rules_max', { p: nf(max) })));
    } else rulesEl.replaceChildren();
    const cats = model.event?.categories ?? [];
    catsEl.replaceChildren(...cats.map((c) => el('li', { class: 'chip', style: { '--chip': safeColor(c.color) } }, i18n.pick(c, 'name'))));
    catsEl.hidden = cats.length === 0;
  }

  return {
    set(next) { model = { ...model, ...next }; },
    render,
  };
}
