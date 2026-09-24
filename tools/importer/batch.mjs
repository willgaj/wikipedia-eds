#!/usr/bin/env node
/**
 * Imports the cluster in articles.json, one article at a time.
 *
 *   npm run import:batch -- --dry-run                 # transform + validate only
 *   npm run import:batch -- [--only <slug,...>] [--publish] [--channel msedge]
 *
 * Per article, each step gates the next:
 *   1. run.mjs --upload --preview --check-delivered   (validation, DA, delivered-markup check)
 *   2. verify/article.mjs on the preview host         (browser checks, desktop + mobile)
 *   3. --publish: publish to live
 * Failures stay unpublished and are listed at the end; tools/output/batch-report.json has details.
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import transformer from './import.js';
import { hostUrl, publish } from '../lib/admin.mjs';

const TOOLS = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { values: opts } = parseArgs({
  options: {
    'dry-run': { type: 'boolean', default: false },
    publish: { type: 'boolean', default: false },
    only: { type: 'string' },
    channel: { type: 'string', default: 'msedge' },
    articles: { type: 'string', default: path.join(TOOLS, 'importer', 'articles.json') },
  },
});

/** Runs a node script, returns { code, lines } (output also streamed, indented). */
function runNode(script, args) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ['--disable-warning=MODULE_TYPELESS_PACKAGE_JSON', script, ...args]);
    const lines = [];
    const collect = (buf) => buf.toString().split('\n').filter(Boolean).forEach((l) => lines.push(l));
    child.stdout.on('data', collect);
    child.stderr.on('data', collect);
    child.on('close', (code) => resolve({ code, lines }));
  });
}

const only = opts.only ? new Set(opts.only.split(',').map((s) => s.trim())) : null;
const articles = JSON.parse(fs.readFileSync(opts.articles, 'utf8')).articles
  .map(({ title, revision }) => {
    const wikiTitle = encodeURIComponent(title.replace(/ /g, '_'));
    return {
      title,
      source: `https://en.wikipedia.org/w/index.php?title=${wikiTitle}&oldid=${revision}&action=render`,
      webPath: transformer.generateDocumentPath({ url: `https://en.wikipedia.org/wiki/${wikiTitle}` }),
    };
  })
  .filter((a) => !only || only.has(a.webPath.replace('/wiki/', '')));
const results = [];

for (const { title, source, webPath } of articles) {
  const result = {
    title, webPath, status: 'ok', problems: [],
  };
  results.push(result);
  const started = Date.now();

  const importArgs = [source, '--articles', opts.articles];
  if (!opts['dry-run']) importArgs.push('--upload', '--preview', '--check-delivered');
  const imp = await runNode(path.join(TOOLS, 'importer', 'run.mjs'), importArgs);
  result.warnings = imp.lines.filter((l) => l.includes('warning:')).map((l) => l.trim());
  result.transform = imp.lines.find((l) => l.includes('transform:'))?.trim();
  if (imp.code !== 0) {
    result.status = 'import failed';
    result.problems = imp.lines.filter((l) => /ERROR|MISMATCH|Error|error/.test(l)).map((l) => l.trim());
  } else if (!opts['dry-run']) {
    const ver = await runNode(path.join(TOOLS, 'verify', 'article.mjs'), [`${hostUrl('page')}${webPath}`, '--channel', opts.channel]);
    if (ver.code !== 0) {
      result.status = 'browser checks failed';
      result.problems = ver.lines.filter((l) => l.includes('FAIL')).map((l) => l.trim());
    } else if (opts.publish) {
      try {
        await publish(webPath);
        result.status = 'published';
      } catch (e) {
        result.status = 'publish failed';
        result.problems = [e.message];
      }
    }
  }
  result.seconds = Math.round((Date.now() - started) / 1000);
  const mark = /ok|published/.test(result.status) ? 'OK  ' : 'FAIL';
  console.log(`${mark} ${title.padEnd(36)} ${result.status} (${result.seconds}s)`);
  result.problems.forEach((p) => console.log(`       ${p}`));
}

fs.mkdirSync(path.join(TOOLS, 'output'), { recursive: true });
fs.writeFileSync(path.join(TOOLS, 'output', 'batch-report.json'), `${JSON.stringify(results, null, 2)}\n`);
const failed = results.filter((r) => !/ok|published/.test(r.status));
console.log(`\n${results.length - failed.length}/${results.length} passed${failed.length ? `; failed: ${failed.map((r) => r.title).join(', ')}` : ''}`);
process.exit(failed.length ? 1 : 0);
