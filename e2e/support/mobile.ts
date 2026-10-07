/**
 * Mobile sanity helpers: horizontal overflow and touch target sizes, measured on what is rendered.
 */
import type { Page } from '@playwright/test';

export interface TargetReport { coarse: boolean; min: number; small: string[]; overflow: number; offenders: string[] }

/** Interactive controls smaller than `min` CSS pixels in either dimension. Inline links in running text are exempt (WCAG 2.5.8). */
export async function measureTargets(page: Page, min?: number): Promise<TargetReport> {
  return page.evaluate((forced) => {
    const coarse = window.matchMedia('(pointer: coarse)').matches;
    const need = forced ?? (coarse ? 44 : 24); // design system: 44px on touch screens; WCAG 2.5.8 minimum 24px otherwise
    const sel = 'a[href], button, select, textarea, summary, [role="button"], [role="tab"], [role="menuitem"], [role="menuitemradio"], [role="switch"], input:not([type="hidden"])';
    const small: string[] = [];
    const seen = new Set<Element>();
    for (const raw of document.querySelectorAll(sel)) {
      let el: Element = raw;
      // radios / checkboxes / switches are operated through their label, or through the transparent input laid over the
      // control (segmented controls): the hit area is the larger of the two
      let hit: Element | null = null;
      if (el instanceof HTMLInputElement && ['radio', 'checkbox'].includes(el.type)) {
        const label = el.closest('label');
        const area = (e: Element) => { const b = e.getBoundingClientRect(); return b.width * b.height; };
        const input = el;
        if (label) { el = label; if (area(input) > area(label)) hit = input; }
      }
      if (seen.has(el)) continue;
      seen.add(el);
      if (el.closest('[hidden], [inert], .skip-link, .u-sr-only')) continue;
      const cs = getComputedStyle(el);
      if (cs.visibility === 'hidden' || cs.display === 'none' || cs.pointerEvents === 'none') continue;
      const r = (hit ?? el).getBoundingClientRect();
      if (r.width === 0 || r.height === 0) continue;
      if (el.tagName === 'A' && cs.display === 'inline' && el.closest('p, li, .alert__text, .field__help, dd')) continue; // inline link in a sentence
      // WCAG 2.5.8 "equivalent": the same destination is also offered by a big enough control in the same card / row
      const href = el.getAttribute('href');
      if (href && el.tagName === 'A') {
        const twin = [...(el.closest('article, li, tr, section, .card')?.querySelectorAll(`a[href="${CSS.escape(href)}"]`) ?? [])].find((a) => {
          if (a === el) return false; const b = a.getBoundingClientRect(); return b.width >= need && b.height >= need;
        });
        if (twin) continue;
      }
      if ((el as HTMLElement).offsetParent === null && cs.position !== 'fixed') continue;
      // a transparent ::before / ::after laid out beyond the control enlarges what can be tapped (design system trick)
      let w = r.width; let h = r.height;
      for (const pseudo of ['::before', '::after'] as const) {
        const ps = getComputedStyle(el, pseudo);
        if (ps.content === 'none' || ps.position !== 'absolute') continue;
        const px = (v: string) => (Number.isFinite(parseFloat(v)) ? parseFloat(v) : 0);
        h += Math.max(0, -px(ps.top)) + Math.max(0, -px(ps.bottom));
        w += Math.max(0, -px(ps.left)) + Math.max(0, -px(ps.right));
      }
      if (w < need - 0.5 || h < need - 0.5) {
        const label = ((el.getAttribute('aria-label') || el.textContent || '').trim().replace(/\s+/g, ' ')).slice(0, 28);
        small.push(`${el.tagName.toLowerCase()}${(el as HTMLElement).className ? '.' + String((el as HTMLElement).className).trim().split(/\s+/).slice(0, 2).join('.') : ''} "${label}" ${Math.round(w)}x${Math.round(h)}`);
      }
    }
    const overflow = Math.max(0, document.documentElement.scrollWidth - document.documentElement.clientWidth);
    const offenders: string[] = [];
    if (overflow > 1) {
      const vw = document.documentElement.clientWidth;
      for (const el of document.querySelectorAll('body *')) {
        const r = el.getBoundingClientRect();
        if (r.width > 0 && r.right > vw + 1 && !el.closest('[hidden]')) { offenders.push(`${el.tagName.toLowerCase()}.${String((el as HTMLElement).className).trim().split(/\s+/).slice(0, 2).join('.')} right=${Math.round(r.right)}`); if (offenders.length >= 6) break; }
      }
    }
    return { coarse, min: need, small, overflow, offenders };
  }, min ?? null);
}
