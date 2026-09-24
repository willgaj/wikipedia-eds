#!/usr/bin/env node
/**
 * Browser checks for a rendered article (decorated DOM, which .plain.html cannot show).
 *
 *   npm run verify:article -- <url> [--channel msedge] [--out <dir>]
 *
 * Exits 1 if any check fails. Screenshots go to <out>.
 */
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import {
  VIEWPORTS, launch, openPage, loadFully, report,
} from './lib/browser.mjs';

const TOOLS = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { values: opts, positionals: [url] } = parseArgs({
  allowPositionals: true,
  options: {
    channel: { type: 'string', default: 'msedge' },
    out: { type: 'string', default: path.join(TOOLS, 'output', 'verify') },
  },
});
if (!url) {
  console.error('usage: npm run verify:article -- <url> [--channel msedge] [--out <dir>]');
  process.exit(2);
}
fs.mkdirSync(opts.out, { recursive: true });
const slug = new URL(url).pathname.split('/').filter(Boolean).pop() || 'index';

function inspect() {
  const q = (s) => document.querySelector(s);
  const blocks = [...document.querySelectorAll('.block')];
  // inline markers and the backlinks the references block adds (#cite-2-ref-0) share the prefix
  const refLinks = [...document.querySelectorAll('main a[href^="#cite-"], main a[href^="#note-"]')];
  const markers = refLinks.filter((a) => !a.closest('.references-backlinks'));
  const infobox = q('.infobox');
  const caption = infobox?.querySelector('caption')?.getBoundingClientRect();
  const box = infobox?.getBoundingClientRect();
  const attribution = q('.attribution');
  return {
    bodyClass: document.body.className,
    blockStatus: blocks.reduce((acc, b) => {
      const k = `${b.dataset.blockName}:${b.dataset.blockStatus}`;
      acc[k] = (acc[k] || 0) + 1;
      return acc;
    }, {}),
    allLoaded: blocks.every((b) => b.dataset.blockStatus === 'loaded'),
    refLinks: refLinks.length,
    markers: markers.length,
    brokenRefLinks: refLinks.filter((a) => !document.getElementById(a.getAttribute('href').slice(1))).length,
    markersWithBacklinkIds: document.querySelectorAll('main a[id*="-ref-"]').length,
    citations: document.querySelectorAll('.references:not(.notes) li[id^="cite-"]').length,
    notes: document.querySelectorAll('.references.notes li[id^="note-"]').length,
    infobox: infobox ? {
      captionInside: !caption
        || (caption.top >= box.top && caption.left >= box.left && caption.right <= box.right),
      float: getComputedStyle(q('.infobox-wrapper')).float,
    } : null,
    attributionOk: !!attribution?.querySelector('a[href^="https://creativecommons.org/licenses/by-sa/"]')
      && !!attribution?.querySelector('a[href^="https://en.wikipedia.org/"]'),
    mathRendered: document.querySelectorAll('main .math math').length,
    mathPending: [...document.querySelectorAll('main code:not(.math-error)')]
      .filter((c) => /^\$[\s\S]+\$$/.test(c.textContent.trim())).length,
    mathErrors: [...document.querySelectorAll('main code.math-error')].map((c) => c.title.slice(0, 80)),
    tables: document.querySelectorAll('main .table table').length,
    toc: (() => {
      const heads = [...document.querySelectorAll('main .section > .default-content-wrapper > :is(h2, h3)')]
        .filter((h) => h.id && h.textContent.trim());
      const nav = q('main > nav.toc');
      if (!nav) return { present: false, headings: heads.length };
      const links = [...nav.querySelectorAll('a')];
      const rect = nav.getBoundingClientRect();
      const content = q('main > .section')?.getBoundingClientRect();
      return {
        present: true,
        headings: heads.length,
        entries: links.length,
        unresolved: links.filter((a) => !document.getElementById(decodeURIComponent(a.getAttribute('href').slice(1)))).length,
        open: nav.querySelector('details').open,
        position: getComputedStyle(nav).position,
        besideContent: rect.right <= (content?.left ?? 0) + 1,
        height: Math.round(rect.height),
      };
    })(),
    header: q('header .header')?.dataset.blockStatus,
    footer: q('footer .footer')?.dataset.blockStatus,
    hScroll: document.documentElement.scrollWidth > window.innerWidth,
  };
}

const browser = await launch(opts.channel);
let failures = 0;
try {
  for (const [label, viewport] of Object.entries(VIEWPORTS)) {
    const { page, problems } = await openPage(browser, viewport);
    await page.addInitScript(() => {
      window.cls = 0;
      new PerformanceObserver((list) => list.getEntries().forEach((e) => {
        if (!e.hadRecentInput) window.cls += e.value;
      })).observe({ type: 'layout-shift', buffered: true });
    });
    await page.goto(url, { waitUntil: 'networkidle' });
    await page.waitForTimeout(1000);
    const cls = await page.evaluate(() => window.cls); // initial load, before any scrolling
    await loadFully(page);
    // maths renders after sections load (scripts/math.js); wait until no TeX is left pending
    await page.waitForFunction(() => ![...document.querySelectorAll('main code:not(.math-error)')]
      .some((c) => /^\$[\s\S]+\$$/.test(c.textContent.trim())), null, { timeout: 15000 })
      .catch(() => {});
    const r = await page.evaluate(inspect);
    await page.screenshot({ path: path.join(opts.out, `${slug}-${label}.png`) });

    // contents: stays in view and marks the section while scrolling; a jump lands below the header
    let tocScroll = null;
    let tocJump = null;
    if (r.toc.present) {
      tocScroll = await page.evaluate(async () => {
        window.scrollTo(0, document.body.scrollHeight * 0.6);
        await new Promise((res) => { setTimeout(res, 400); });
        const nav = document.querySelector('main > nav.toc');
        return {
          top: Math.round(nav.getBoundingClientRect().top),
          navH: parseInt(getComputedStyle(document.documentElement).getPropertyValue('--nav-height'), 10),
          marked: nav.querySelectorAll('[aria-current]').length,
        };
      });
      const target = await page.evaluate(() => {
        const links = [...document.querySelectorAll('main > nav.toc a')];
        return links[Math.floor(links.length / 2)].getAttribute('href');
      });
      const open = await page.locator('main > nav.toc details').evaluate((d) => d.open);
      if (!open) await page.click('main > nav.toc summary');
      await page.click(`main > nav.toc a[href="${target}"]`);
      await page.waitForTimeout(600);
      tocJump = await page.evaluate((href) => {
        const h = document.getElementById(decodeURIComponent(href.slice(1)));
        const navH = parseInt(getComputedStyle(document.documentElement).getPropertyValue('--nav-height'), 10);
        const bar = document.querySelector('main > nav.toc');
        // a column (wide screens) covers nothing above the heading; a bar covers down to its bottom
        const covered = window.innerWidth >= 1200 ? navH : bar.getBoundingClientRect().bottom;
        return {
          top: Math.round(h.getBoundingClientRect().top),
          covered: Math.round(covered),
          vh: window.innerHeight,
          closed: !bar.querySelector('details').open,
        };
      }, target);
    }
    failures += report(label, {
      'article template': [r.bodyClass.split(' ').includes('article'), r.bodyClass],
      'blocks loaded': [r.allLoaded, r.blockStatus],
      'header and footer loaded': [r.header === 'loaded' && r.footer === 'loaded'],
      'no errors or failed requests': [!problems.length, problems.length ? problems : undefined],
      'attribution with source and CC BY-SA links': [r.attributionOk],
      'reference and back links resolve': [r.brokenRefLinks === 0, `${r.refLinks} links, ${r.brokenRefLinks} broken`],
      'reference lists for markers': [!r.markers || r.citations + r.notes > 0, `${r.markers} markers, ${r.citations} citations, ${r.notes} notes`],
      'backlink ids on every marker': [r.markersWithBacklinkIds === r.markers, `${r.markersWithBacklinkIds}/${r.markers}`],
      'infobox caption inside border': [!r.infobox || r.infobox.captionInside, r.infobox ? undefined : 'no infobox'],
      'infobox floats on desktop only': [!r.infobox || r.infobox.float === (label === 'desktop' ? 'right' : 'none'), r.infobox?.float],
      'maths rendered': [!r.mathPending && !r.mathErrors.length, `${r.mathRendered} rendered, ${r.mathPending} pending${r.mathErrors.length ? `, errors: ${JSON.stringify(r.mathErrors)}` : ''}`],
      'contents list': [
        r.toc.headings < 4 ? !r.toc.present
          : r.toc.present && r.toc.entries === r.toc.headings && !r.toc.unresolved,
        r.toc.present ? `${r.toc.entries} entries for ${r.toc.headings} headings, ${r.toc.unresolved} unresolved`
          : `none (${r.toc.headings} headings)`,
      ],
      'contents layout (column on desktop, closed bar on mobile)': [
        !r.toc.present || (label === 'desktop'
          ? r.toc.open && r.toc.position === 'sticky' && r.toc.besideContent
          : !r.toc.open && r.toc.height < 80),
        r.toc.present ? `${r.toc.position}, ${r.toc.open ? 'open' : 'closed'}, height ${r.toc.height}` : undefined,
      ],
      'contents stays in view and marks the section': [
        !tocScroll || (Math.abs(tocScroll.top - tocScroll.navH) <= 30 && tocScroll.marked === 1),
        tocScroll ? `top ${tocScroll.top}px, ${tocScroll.marked} marked` : undefined,
      ],
      'contents jump lands below the header': [
        !tocJump || (tocJump.top >= tocJump.covered && tocJump.top < tocJump.vh / 2
          && (label === 'desktop' || tocJump.closed)),
        tocJump ? `heading at ${tocJump.top}px, covered to ${tocJump.covered}px` : undefined,
      ],
      // blocking: every article measured 0.000 once web fonts were removed (system font stacks)
      'layout shift on load < 0.1': [cls < 0.1, cls.toFixed(3)],
      'no horizontal scroll': [!r.hScroll],
    });
    await page.close();
  }
} finally {
  await browser.close();
}
console.log(failures ? `${failures} check(s) failed` : 'all checks passed');
process.exit(failures ? 1 : 0);
