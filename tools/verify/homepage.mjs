#!/usr/bin/env node
/**
 * Browser checks for the homepage article list against the live query index.
 *
 *   npm run verify:home -- [<base-url>] [--mock <n>] [--channel msedge] [--out <dir>]
 *
 * <base-url> defaults to the main preview host. --mock serves n made-up index rows to the
 * browser instead of the real index (nothing on the site changes), to test the grid at scale.
 */
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { hostUrl } from '../lib/admin.mjs';
import { fetch } from '../lib/http.mjs';
import {
  VIEWPORTS, launch, openPage, loadFully, report,
} from './lib/browser.mjs';

const TOOLS = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { values: opts, positionals: [baseArg] } = parseArgs({
  allowPositionals: true,
  options: {
    mock: { type: 'string' },
    channel: { type: 'string', default: 'msedge' },
    out: { type: 'string', default: path.join(TOOLS, 'output', 'verify') },
  },
});
const base = (baseArg || hostUrl('page')).replace(/\/$/, '');
fs.mkdirSync(opts.out, { recursive: true });

let rows;
let route;
if (opts.mock !== undefined) {
  rows = [...Array(Number(opts.mock))].map((_, i) => ({
    path: `/wiki/mock-${i + 1}`, title: `Mock article ${String(i + 1).padStart(2, '0')}`, description: 'Made-up index row for layout testing', lastModified: 0,
  }));
  const body = JSON.stringify({
    total: rows.length, offset: 0, limit: rows.length, data: rows, ':type': 'sheet',
  });
  route = { url: '**/query-index.json', handler: (r) => r.fulfill({ contentType: 'application/json', body }) };
} else {
  const index = await fetch(`${base}/query-index.json`).then((r) => (r.ok ? r.json() : { data: [] }));
  rows = index.data;
}
const expected = rows
  .filter((r) => r.path && r.title)
  .sort((a, b) => a.title.localeCompare(b.title));
const expectedCount = expected.length ? `${expected.length} ${expected.length === 1 ? 'article' : 'articles'}` : null;
console.log(`${base}/ against ${opts.mock !== undefined ? `${expected.length} mock rows` : `query index (${expected.length} rows)`}`);

const browser = await launch(opts.channel);
let failures = 0;
try {
  for (const [label, viewport] of Object.entries(VIEWPORTS)) {
    const { page, problems } = await openPage(browser, viewport, { route });
    await page.goto(`${base}/`, { waitUntil: 'networkidle' });
    await loadFully(page);
    const r = await page.evaluate(() => {
      const list = document.querySelector('.article-list');
      const ul = list?.querySelector('ul');
      return {
        bodyClass: document.body.className,
        status: list?.dataset.blockStatus,
        count: list?.querySelector('.article-list-count')?.textContent,
        message: list?.querySelector('.article-list-message')?.textContent,
        cards: [...(list?.querySelectorAll('li h2 a') || [])].map((a) => a.getAttribute('href')),
        columns: ul ? getComputedStyle(ul).gridTemplateColumns.split(' ').length : 0,
        hScroll: document.documentElement.scrollWidth > window.innerWidth,
      };
    });
    await page.screenshot({ path: path.join(opts.out, `home${opts.mock !== undefined ? '-mock' : ''}-${label}.png`), fullPage: true });
    const wantColumns = label === 'desktop' ? 3 : 1;
    failures += report(label, {
      'portal template': [r.bodyClass.split(' ').includes('portal'), r.bodyClass],
      'article-list loaded': [r.status === 'loaded', r.status],
      'no errors or failed requests': [!problems.length, problems.length ? problems : undefined],
      'count matches index': [expectedCount ? r.count === expectedCount : !!r.message, r.count || r.message],
      'cards match index, sorted by title': [JSON.stringify(r.cards) === JSON.stringify(expected.map((e) => e.path)), `${r.cards.length} cards`],
      [`${wantColumns}-column grid`]: [!expected.length || r.columns === wantColumns, r.columns],
      'no horizontal scroll': [!r.hScroll],
    });
    await page.close();
  }
} finally {
  await browser.close();
}
console.log(failures ? `${failures} check(s) failed` : 'all checks passed');
process.exit(failures ? 1 : 0);
