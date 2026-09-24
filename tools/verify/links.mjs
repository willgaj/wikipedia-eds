#!/usr/bin/env node
/**
 * Site-wide check of links between imported articles, from the delivered markup.
 *
 *   npm run verify:links -- [<base-url>]      # default: main live host
 *
 * Every local /wiki/ link must reach a page in the query index; links with a section anchor are
 * reported when the target has no element with that id (often a section renamed on Wikipedia,
 * where the same link is also broken). Exits 1 only for missing pages.
 */
import { JSDOM } from 'jsdom';
import { hostUrl } from '../lib/admin.mjs';
import { fetch } from '../lib/http.mjs';

const base = (process.argv[2] || hostUrl('live')).replace(/\/$/, '');
const { data } = await fetch(`${base}/query-index.json`).then((r) => r.json());
const pages = new Map();
for (const { path } of data) {
  const html = await fetch(`${base}${path}.plain.html`).then((r) => r.text());
  if (!html.includes('<')) throw new Error(`${path}.plain.html is not HTML (undecoded response?)`);
  pages.set(path, new JSDOM(html).window.document);
}

let links = 0;
const missingPages = [];
const missingAnchors = [];
pages.forEach((doc, path) => {
  doc.querySelectorAll('a[href^="/wiki/"]').forEach((a) => {
    const [target, fragment] = a.getAttribute('href').split('#');
    links += 1;
    if (!pages.has(target)) missingPages.push(`${path} -> ${a.getAttribute('href')}`);
    else if (fragment && !pages.get(target).getElementById(decodeURIComponent(fragment))) {
      missingAnchors.push(`${path} -> ${target}#${fragment} ("${a.textContent.trim()}")`);
    }
  });
});

console.log(`${pages.size} pages, ${links} local links`);
console.log(`missing pages: ${missingPages.length}`);
missingPages.forEach((m) => console.log(`  ${m}`));
console.log(`missing section anchors (page still opens): ${missingAnchors.length}`);
missingAnchors.forEach((m) => console.log(`  ${m}`));
process.exit(missingPages.length ? 1 : 0);
