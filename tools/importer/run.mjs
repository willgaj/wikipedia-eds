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
 * Always writes <out>/<path>.html and <path>.report.json. Validation errors stop before upload.
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
  },
});

if (!sourceUrl) {
  console.error('usage: npm run import -- <source-url> [--upload] [--preview] [--publish] [--check-delivered] [--out <dir>]');
  process.exit(2);
}
if (!new URL(sourceUrl).searchParams.get('oldid')) {
  console.warn('warning: no oldid in source URL; attribution will have no revision permalink');
}

const step = (msg) => console.log(`• ${msg}`);

// 1. fetch
const resp = await fetch(sourceUrl, { headers: { 'User-Agent': USER_AGENT } });
if (!resp.ok) throw new Error(`fetch ${sourceUrl} -> ${resp.status}`);
const html = await resp.text();
step(`fetched ${sourceUrl} (${html.length} bytes)`);

// 2. transform (import.js expects the importer UI's WebImporter global)
const { document } = new JSDOM(`<!DOCTYPE html><html><body>${html}</body></html>`, { url: sourceUrl }).window;
globalThis.WebImporter = { Blocks, DOMUtils };
const params = { originalURL: sourceUrl };
const main = transformer.transformDOM({
  document, url: sourceUrl, html, params,
});
const webPath = transformer.generateDocumentPath({ document, url: sourceUrl, params });
const daHtml = toDaHtml(document, main);

// 3. validate + write
const report = { source: sourceUrl, webPath, ...validateDaHtml(daHtml) };
const outFile = path.join(opts.out, `${webPath.replace(/^\//, '') || 'index'}.html`);
fs.mkdirSync(path.dirname(outFile), { recursive: true });
fs.writeFileSync(outFile, daHtml);
const writeReport = () => fs.writeFileSync(outFile.replace(/\.html$/, '.report.json'), `${JSON.stringify(report, null, 2)}\n`);
writeReport();
step(`wrote ${path.relative(process.cwd(), outFile)} -> ${webPath}`);
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
  report.delivered = compareDelivered(daHtml, plain);
  writeReport();
  report.delivered.errors.forEach((e) => console.log(`  DELIVERED MISMATCH: ${e}`));
  step(`delivered markup ${report.delivered.errors.length ? 'differs' : 'matches'} (${hostUrl('page')}${webPath}.plain.html)`);
  if (report.delivered.errors.length) process.exit(1);
}
if (opts.publish) { await publish(webPath); step(`published ${hostUrl('live')}${webPath}`); }
