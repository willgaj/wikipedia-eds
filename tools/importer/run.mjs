#!/usr/bin/env node
/**
 * Headless import: Wikipedia (Parsoid ?action=render) -> DA document -> preview/live.
 *
 *   npm run import -- <source-url> [--upload] [--preview] [--publish] [--check-delivered]
 *                                  [--out <dir>]
 *
 * <source-url> should pin a revision so attribution carries a permalink:
 *   https://en.wikipedia.org/w/index.php?title=Nikola_Tesla&oldid=1372910045&action=render
 *
 * Always writes <out>/<path>.html, .report.json and .source.html (the fetched input).
 * Validation errors stop before upload.
 * Env: WIKIMEDIA_USER_AGENT (see https://foundation.wikimedia.org/wiki/Policy:User-Agent_policy),
 *      DA_TOKEN, AEM_ORG / AEM_SITE / AEM_REF (see ../lib/admin.mjs).
 */
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';
import { Blocks, DOMUtils } from '@adobe/helix-importer';
import transformer from './import.js';
import toDaHtml from './lib/da-html.mjs';
import { validateDaHtml, compareDelivered } from './lib/validate.mjs';
import { fetch } from '../lib/http.mjs';
import {
  hostUrl, putSource, preview, publish,
} from '../lib/admin.mjs';

const TOOLS = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const USER_AGENT = process.env.WIKIMEDIA_USER_AGENT
  || 'wikipedia-eds-poc/0.1 (https://github.com/willgaj/wikipedia-eds)';

const { values: opts, positionals: [sourceUrl] } = parseArgs({
  allowPositionals: true,
  options: {
    upload: { type: 'boolean', default: false },
    preview: { type: 'boolean', default: false },
    publish: { type: 'boolean', default: false },
    'check-delivered': { type: 'boolean', default: false },
    out: { type: 'string', default: path.join(TOOLS, 'output', 'import') },
    articles: { type: 'string', default: path.join(TOOLS, 'importer', 'articles.json') },
  },
});

/**
 * Title (and every redirect to it) -> local web path, for each article in the cluster, so links
 * between imported articles stay on this site.
 */
function localArticles(file) {
  if (!fs.existsSync(file)) return {};
  const map = {};
  JSON.parse(fs.readFileSync(file, 'utf8')).articles.forEach(({ title, redirects = [] }) => {
    const url = `https://en.wikipedia.org/wiki/${encodeURIComponent(title.replace(/ /g, '_'))}`;
    const webPath = transformer.generateDocumentPath({ url });
    [title, ...redirects].forEach((t) => { map[t] = webPath; });
  });
  return map;
}

if (!sourceUrl) {
  console.error('usage: npm run import -- <source-url> [--upload] [--preview] [--publish] [--check-delivered] [--out <dir>]');
  process.exit(2);
}
if (!new URL(sourceUrl).searchParams.get('oldid')) {
  console.warn('warning: no oldid in source URL; attribution will have no revision permalink');
}

const step = (msg) => console.log(`• ${msg}`);

/**
 * Wikipedia intermittently answers ?action=render with 500 for a page (observed for minutes at a
 * time, independent of request headers), so retry 5xx/429 with backoff before giving up.
 */
async function fetchSource(url, attempts = 5) {
  for (let i = 1; ; i += 1) {
    const resp = await fetch(url, { headers: { 'User-Agent': USER_AGENT } });
    if (resp.ok) return resp.text();
    const retryable = resp.status >= 500 || resp.status === 429;
    if (!retryable || i >= attempts) throw new Error(`fetch ${url} -> ${resp.status} after ${i} attempt(s)`);
    const wait = Number(resp.headers.get('retry-after')) * 1000 || 2000 * 2 ** (i - 1);
    console.warn(`  fetch -> ${resp.status}, retrying in ${wait / 1000}s (${i}/${attempts})`);
    await new Promise((r) => { setTimeout(r, wait); });
  }
}

// 1. fetch
const html = await fetchSource(sourceUrl);
step(`fetched ${sourceUrl} (${html.length} bytes)`);

// 2. transform (import.js expects the importer UI's WebImporter global)
const { document } = new JSDOM(`<!DOCTYPE html><html><body>${html}</body></html>`, { url: sourceUrl }).window;
globalThis.WebImporter = { Blocks, DOMUtils };
const params = {
  originalURL: sourceUrl,
  localArticles: localArticles(opts.articles),
  siteOrigin: hostUrl('page'), // the pipeline rewrites own-site URLs to relative paths
};
const main = transformer.transformDOM({
  document, url: sourceUrl, html, params,
});
const webPath = transformer.generateDocumentPath({ document, url: sourceUrl, params });
const daHtml = toDaHtml(document, main);

// 3. validate + write (the transform's own counts let validation detect silent content loss)
const report = {
  source: sourceUrl, webPath, transform: params.report, ...validateDaHtml(daHtml, params.report),
};
const outFile = path.join(opts.out, `${webPath.replace(/^\//, '') || 'index'}.html`);
fs.mkdirSync(path.dirname(outFile), { recursive: true });
fs.writeFileSync(outFile, daHtml);
fs.writeFileSync(outFile.replace(/\.html$/, '.source.html'), html); // what the transform received
const writeReport = () => fs.writeFileSync(outFile.replace(/\.html$/, '.report.json'), `${JSON.stringify(report, null, 2)}\n`);
writeReport();
step(`wrote ${path.relative(process.cwd(), outFile)} -> ${webPath}`);
console.log(`  transform: ${JSON.stringify(report.transform)}`);
console.log(`  stats: ${JSON.stringify(report.stats)}`);
report.warnings.forEach((w) => console.log(`  warning: ${w}`));
report.errors.forEach((e) => console.log(`  ERROR: ${e}`));
if (report.errors.length) {
  console.error(`${report.errors.length} validation error(s); nothing uploaded`);
  process.exit(1);
}

// 4. DA + admin
if (opts.upload) { await putSource(webPath, daHtml); step('uploaded to DA'); }
if (opts.preview) { await preview(webPath); step(`previewed ${hostUrl('page')}${webPath}`); }
if (opts['check-delivered']) {
  const plain = await fetch(`${hostUrl('page')}${webPath}.plain.html`).then((r) => r.text());
  if (!plain.includes('<div')) throw new Error('delivered .plain.html is not HTML (undecoded response?)');
  report.delivered = compareDelivered(daHtml, plain);
  writeReport();
  report.delivered.errors.forEach((e) => console.log(`  DELIVERED MISMATCH: ${e}`));
  step(`delivered markup ${report.delivered.errors.length ? 'differs' : 'matches'} (${hostUrl('page')}${webPath}.plain.html)`);
  if (report.delivered.errors.length) process.exit(1);
}
if (opts.publish) { await publish(webPath); step(`published ${hostUrl('live')}${webPath}`); }
