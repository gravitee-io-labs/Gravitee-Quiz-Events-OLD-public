/**
 * (6) Admin: edit the appearance (colours, background, theme, texts) and see it on the public pages.
 */
import { test, expect } from '../support/fixtures';
import { admin } from '../support/api';
import { gotoTab, dialog, toast } from '../support/admin';
import { openEvent } from '../support/ui';
import type { Page } from '@playwright/test';

test.use({ asAdmin: true });

const colour = (page: Page, label: 'Primary colour' | 'Accent colour') => page.getByRole('textbox', { name: label, exact: true });
const save = (page: Page) => page.getByRole('button', { name: 'Save changes' });
const cssVar = (page: Page, name: string, selector = 'html') =>
  page.locator(selector).first().evaluate((el, n) => (el as HTMLElement).style.getPropertyValue(n).trim().toLowerCase(), name);

test.describe('appearance', () => {
  test('colours, background, theme and texts are saved and show on the landing page and the hub card', async ({ page, browser, events }) => {
    const ev = await events.create({ tag: 'appear', name: 'Appearance Summit', gameTitle: 'Palette Masters', questions: 6, perGame: 5, primary: '#7C5CFF', accent: '#22D3EE' });
    await gotoTab(page, ev, 'appearance');

    // starts clean: nothing to save
    await expect(save(page)).toBeDisabled();
    await expect(colour(page, 'Primary colour')).toHaveValue('#7C5CFF');

    await colour(page, 'Primary colour').fill('#E11D48');
    await colour(page, 'Accent colour').fill('#F59E0B');
    await page.getByRole('radiogroup', { name: 'Background' }).getByRole('radio', { name: 'Grid' }).check();
    await page.getByRole('radiogroup', { name: 'Default theme' }).getByRole('radio', { name: 'Light' }).check();
    await page.getByRole('textbox', { name: /^Tagline/ }).fill('Painted in rose and amber');
    await page.getByRole('textbox', { name: /^Headline/ }).fill('Become THE Palette Champion!');
    await page.getByRole('tab', { name: 'Français' }).click();
    await page.getByRole('textbox', { name: /^Tagline/ }).fill('Peint en rose et ambre');
    await page.getByRole('tab', { name: 'English' }).click();
    await page.getByRole('textbox', { name: /^Location/ }).fill('Eindhoven');

    // the contrast panel reacts to the new colours
    await expect(page.getByText('Accessible in both themes')).toBeVisible();
    await expect(save(page)).toBeEnabled();
    await save(page).click();
    await expect(toast(page, 'Appearance saved')).toBeVisible();
    await expect(save(page)).toBeDisabled();

    const stored = await admin.get(`/admin/events/${ev.id}`);
    expect(stored.branding).toMatchObject({ primary_color: '#E11D48', accent_color: '#F59E0B', background_style: 'grid', default_theme: 'light' });
    expect(stored).toMatchObject({ tagline_en: 'Painted in rose and amber', tagline_fr: 'Peint en rose et ambre', hero_title_en: 'Become THE Palette Champion!', location: 'Eindhoven' });

    // a visitor with a clean browser sees it on the public pages
    const visitor = await browser.newContext();
    const pub = await visitor.newPage();
    try {
      await openEvent(pub, ev.slug);
      await expect(pub.locator('h1.hero__title')).toHaveText('Become THE Palette Champion!');
      await expect(pub.locator('.hero__tagline')).toHaveText('Painted in rose and amber');
      await expect(pub.locator('.hero__eyebrow')).toContainText('Eindhoven');
      expect(await cssVar(pub, '--brand')).toBe('#e11d48');
      expect(await cssVar(pub, '--brand-accent')).toBe('#f59e0b');
      await expect(pub.locator('html')).toHaveAttribute('data-bg', 'grid');
      await expect(pub.locator('html')).toHaveAttribute('data-theme', 'light');
      // the primary button really is brand coloured (derived, readable fill), not the default orange
      const fill = await pub.locator('[data-action="play"]').evaluate((el) => getComputedStyle(el).backgroundColor);
      expect(fill).not.toBe('rgb(252, 86, 7)');

      await pub.goto('/');
      const card = pub.locator('article.hub-card').filter({ has: pub.locator(`a.hub-card__link[href="/${ev.slug}"]`) });
      await expect(card).toBeVisible();
      expect(await card.evaluate((el) => (el as HTMLElement).style.getPropertyValue('--brand').trim().toLowerCase())).toBe('#e11d48');
      await expect(card.locator('.hub-card__tagline')).toHaveText('Painted in rose and amber');
    } finally {
      await visitor.close();
    }
  });

  test('the live preview follows the colours before saving', async ({ page, events }) => {
    const ev = await events.create({ tag: 'appear-prev', questions: 6, perGame: 5, primary: '#7C5CFF' });
    await gotoTab(page, ev, 'appearance');
    const aside = page.getByRole('complementary', { name: 'Live preview' });
    await expect(aside).toBeVisible();
    const brandOf = () => aside.locator('[data-brand-scope]').first().evaluate((el) => (el as HTMLElement).style.getPropertyValue('--brand').trim().toLowerCase());
    expect(await brandOf()).toBe('#7c5cff');
    await colour(page, 'Primary colour').fill('#0F766E');
    await expect.poll(brandOf).toBe('#0f766e');
    // switch the preview to the hub card and to the other language: still renders
    await aside.getByRole('radiogroup', { name: 'Page to preview' }).getByRole('radio', { name: 'Hub card' }).check();
    await aside.getByRole('radiogroup', { name: 'Preview language' }).getByRole('radio', { name: 'FR' }).check();
    await expect(aside.getByRole('radio', { name: 'FR' })).toBeChecked();
  });

  test('the panel always explains what happens to the colour, whatever you pick', async ({ page, events }) => {
    const ev = await events.create({ tag: 'appear-ext', questions: 6, perGame: 5 });
    await gotoTab(page, ev, 'appearance');
    for (const hex of ['#000000', '#FFFFFF', '#FFFF00', '#001F5C']) {
      await colour(page, 'Primary colour').fill(hex);
      await expect(page.locator('.ap-contrast .alert')).toBeVisible();
      await expect(page.locator('.ap-contrast .alert__title')).toHaveText(/Accessible in both themes|Readable in both themes|Worth a second look/);
    }
  });

  test('unsaved changes are guarded; Reset discards them', async ({ page, events }) => {
    const ev = await events.create({ tag: 'appear-dirty', questions: 6, perGame: 5, primary: '#7C5CFF' });
    await gotoTab(page, ev, 'appearance');
    await colour(page, 'Primary colour').fill('#E11D48');
    await expect(save(page)).toBeEnabled();

    // leaving asks first
    await page.getByRole('link', { name: 'Overview' }).first().click();
    const dlg = dialog(page);
    await expect(dlg.getByRole('heading', { name: 'Leave without saving?' })).toBeVisible();
    await dlg.getByRole('button', { name: 'Keep editing' }).click();
    await expect(page).toHaveURL(/\/appearance$/);
    await expect(colour(page, 'Primary colour')).toHaveValue('#E11D48');

    // Reset puts the stored values back
    await page.getByRole('button', { name: 'Reset changes' }).click();
    await expect(colour(page, 'Primary colour')).toHaveValue('#7C5CFF');
    await expect(save(page)).toBeDisabled();
    await page.getByRole('link', { name: 'Overview' }).first().click();
    await expect(page).toHaveURL(/\/overview$/);
    expect((await admin.get(`/admin/events/${ev.id}`)).branding.primary_color).toBe('#7C5CFF');
  });

  test('renaming the slug warns, asks to confirm and moves the public address', async ({ page, events, request }) => {
    const ev = await events.create({ tag: 'appear-slug', questions: 6, perGame: 5 });
    const newSlug = `${ev.slug}-r`.slice(0, 48);
    events.track(newSlug);
    await gotoTab(page, ev, 'appearance');
    await page.getByRole('textbox', { name: 'Slug', exact: true }).fill(newSlug);
    await expect(page.getByText('Renaming the slug changes the public address')).toBeVisible();
    await save(page).click();
    await dialog(page).getByRole('button', { name: 'Rename the slug' }).click();
    await expect(toast(page, 'Appearance saved')).toBeVisible();
    expect((await request.get(`/api/events/${newSlug}`)).status()).toBe(200);
    expect((await request.get(`/api/events/${ev.slug}`)).status()).toBe(404);
  });

  test('a slug that is reserved or malformed cannot be saved', async ({ page, events }) => {
    const ev = await events.create({ tag: 'appear-badslug', questions: 6, perGame: 5 });
    await gotoTab(page, ev, 'appearance');
    const field = page.getByRole('textbox', { name: 'Slug', exact: true });
    await field.fill('admin');
    await save(page).click();
    await expect(page.getByText('is reserved by the platform')).toBeVisible();
    await field.fill('Bad Slug!');
    await save(page).click();
    await expect(page.getByText(/Use lowercase letters, digits and single hyphens/)).toBeVisible();
    expect((await admin.get(`/admin/events/${ev.id}`)).slug).toBe(ev.slug);
  });
});

test.describe('logo and dates', () => {
  test('a same-origin logo path shows on the landing page and the hub card; a javascript: URL is refused', async ({ page, browser, events }) => {
    const ev = await events.create({ tag: 'appear-logo', questions: 6, perGame: 3 });
    await gotoTab(page, ev, 'appearance');
    const logo = page.getByRole('textbox', { name: /^Logo URL/ });
    await logo.fill('javascript:window.__xss=1');
    await save(page).click();
    await expect(page.locator('.field--invalid').first()).toBeVisible();
    expect((await admin.get(`/admin/events/${ev.id}`)).branding.logo_url).toBeNull();

    await logo.fill('/shared/img/gravitee-mark.svg');
    await save(page).click();
    await expect(toast(page, 'Appearance saved')).toBeVisible();
    expect((await admin.get(`/admin/events/${ev.id}`)).branding.logo_url).toBe('/shared/img/gravitee-mark.svg');

    const visitor = await browser.newContext();
    const pub = await visitor.newPage();
    try {
      await openEvent(pub, ev.slug);
      await expect(pub.locator('.ev-emblem__logo')).toBeVisible();
      await expect(pub.locator('.ev-emblem__logo')).toHaveAttribute('src', '/shared/img/gravitee-mark.svg');
      await pub.goto('/');
      await expect(pub.locator('article.hub-card').filter({ has: pub.locator(`a.hub-card__link[href="/${ev.slug}"]`) }).locator('.hub-card__logo')).toBeVisible();
      await pub.goto(`/${ev.slug}/scoreboard`);
      await expect(pub.locator('#sb-logo')).toBeVisible();
    } finally {
      await visitor.close();
    }
  });

  test('dates: an end before the start is refused, a range shows on the landing page', async ({ page, browser, events }) => {
    const ev = await events.create({ tag: 'appear-dates', questions: 6, perGame: 3, location: 'Delft', startsOn: null, endsOn: null });
    await gotoTab(page, ev, 'appearance');
    const starts = page.getByRole('textbox', { name: /^Starts on/ });
    const ends = page.getByRole('textbox', { name: /^Ends on/ });
    await starts.fill('2027-03-12');
    await ends.fill('2027-03-10');
    await save(page).click();
    await expect(page.locator('.field--invalid, .alert--danger:not([hidden])').first()).toBeVisible();
    expect((await admin.get(`/admin/events/${ev.id}`)).starts_on).toBeNull();

    await ends.fill('2027-03-13');
    await save(page).click();
    await expect(toast(page, 'Appearance saved')).toBeVisible();
    const visitor = await browser.newContext({ locale: 'en-GB' });
    const pub = await visitor.newPage();
    try {
      await openEvent(pub, ev.slug);
      await expect(pub.locator('.hero__eyebrow')).toContainText(/12\s*[–-]\s*13\s*Mar\s*2027/);
    } finally {
      await visitor.close();
    }
  });
});

test.describe('arbitrary brand colours stay readable on the public pages', () => {
  // WCAG contrast measured on what the browser really paints (canvas resolves any CSS colour syntax)
  async function playButtonContrast(page: Page): Promise<number> {
    return page.locator('[data-action="play"]').evaluate((btn) => {
      const px = (css: string) => {
        const c = document.createElement('canvas'); c.width = c.height = 1;
        const g = c.getContext('2d', { willReadFrequently: true })!;
        g.clearRect(0, 0, 1, 1); g.fillStyle = css; g.fillRect(0, 0, 1, 1);
        const [r, gr, b, a] = g.getImageData(0, 0, 1, 1).data; return { r, g: gr, b, a };
      };
      const lum = ({ r, g, b }: { r: number; g: number; b: number }) => {
        const f = (v: number) => { const x = v / 255; return x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4; };
        return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
      };
      const cs = getComputedStyle(btn);
      const fg = px(cs.color); const bg = px(cs.backgroundColor);
      const [hi, lo] = [Math.max(lum(fg), lum(bg)), Math.min(lum(fg), lum(bg))];
      return (hi + 0.05) / (lo + 0.05);
    });
  }

  for (const primary of ['#000000', '#FFFFFF', '#FFFF00', '#001F5C', '#FF00FF']) {
    test(`primary ${primary}: the Play button label has at least 4.5:1 in both themes`, async ({ page, events }) => {
      const ev = await events.create({ tag: 'brand-ext', questions: 6, perGame: 5, primary, accent: '#888888' });
      for (const theme of ['dark', 'light']) {
        await page.goto(`/${ev.slug}?theme=${theme}`);
        await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
        await expect(page.locator('[data-action="play"]')).toBeVisible();
        const ratio = await playButtonContrast(page);
        expect(ratio, `${primary} / ${theme}`).toBeGreaterThanOrEqual(4.5);
      }
    });
  }
});
