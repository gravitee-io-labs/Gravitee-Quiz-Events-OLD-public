/**
 * join.js - the "Scan to play" card: QR code (dark on white, quiet zone, scannable from a distance),
 * the short URL printed under it and, for people on a phone, a Play button.
 */
import { el } from '/shared/js/dom.js';
import { qrCode } from '/shared/js/qr.js';
import { shortUrl } from './format.js';

let seq = 0;

/** QR tile only (used by the empty state). */
export function buildQr(url, label) {
  return qrCode(url, { ecc: 'M', margin: 2, label });
}

/**
 * @param {{url:string, t:(k:string,p?:object)=>string}} cfg
 * @returns {{root:HTMLElement, localize:()=>void}}
 */
export function buildJoinCard({ url, t }) {
  const id = `sb-join-${++seq}`;
  const qrHost = el('div', { class: 'sb-join__qr' });
  const title = el('h2', { class: 'sb-join__title', id });
  const text = el('p', { class: 'sb-join__text' });
  const urlEl = el('p', { class: 'sb-url' }, shortUrl(url));
  const cta = el('a', { class: 'btn btn--primary sb-join__cta', href: url });
  const root = el('aside', { class: 'sb-join glass', 'aria-labelledby': id },
    qrHost,
    el('div', { class: 'sb-join__body' }, title, text, urlEl, cta));
  function localize() {
    title.textContent = t('join.title');
    text.textContent = t('join.text');
    cta.textContent = t('join.play');
    qrHost.replaceChildren(buildQr(url, t('join.qr', { url: shortUrl(url) })));
  }
  localize();
  return { root, localize };
}
