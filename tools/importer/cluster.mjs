#!/usr/bin/env node
/**
 * Pins the article cluster in articles.json: canonical title, revision, and the redirects that
 * point at each article (so links through a redirect can be rewritten to the local page too).
 *
 *   npm run cluster:pin              # fills in missing revisions, refreshes redirects
 *   npm run cluster:pin -- --refresh # also moves every article to its current revision
 *
 * Fails on titles that are redirects, disambiguation pages or missing: fix the title instead.
 */
import fs from 'node:fs';
import { parseArgs } from 'node:util';
import { fetch } from '../lib/http.mjs';

const FILE = new URL('./articles.json', import.meta.url);
const API = 'https://en.wikipedia.org/w/api.php';
const USER_AGENT = process.env.WIKIMEDIA_USER_AGENT
  || 'wikipedia-eds-poc/0.1 (https://github.com/willgaj/wikipedia-eds)';

const { values: opts } = parseArgs({ options: { refresh: { type: 'boolean', default: false } } });

async function api(params) {
  const url = new URL(API);
  Object.entries({ format: 'json', formatversion: 2, ...params }).forEach(([k, v]) => url.searchParams.set(k, v));
  const resp = await fetch(url, { headers: { 'User-Agent': USER_AGENT } });
  if (!resp.ok) throw new Error(`${resp.status} ${url}`);
  return resp.json();
}

const cluster = JSON.parse(fs.readFileSync(FILE, 'utf8'));
const byTitle = new Map(cluster.articles.map((a) => [a.title, a]));
const titles = [...byTitle.keys()];
const problems = [];

for (let i = 0; i < titles.length; i += 50) {
  const batch = titles.slice(i, i + 50);
  const info = await api({
    action: 'query', titles: batch.join('|'), prop: 'revisions|pageprops', rvprop: 'ids', ppprop: 'disambiguation',
  });
  (info.query.redirects || []).forEach((r) => problems.push(`"${r.from}" is a redirect to "${r.to}"`));
  info.query.pages.forEach((p) => {
    const article = byTitle.get(p.title);
    if (!article) return; // normalised or redirected title, reported above
    if (p.missing) { problems.push(`"${p.title}" does not exist`); return; }
    if (p.pageprops && 'disambiguation' in p.pageprops) problems.push(`"${p.title}" is a disambiguation page`);
    if (opts.refresh || !article.revision) article.revision = p.revisions[0].revid;
  });

  // every redirect (article namespace) that points at these titles
  const redirects = new Map(batch.map((t) => [t, []]));
  let cont = {};
  do {
    const r = await api({
      action: 'query', titles: batch.join('|'), prop: 'redirects', rdlimit: 'max', rdnamespace: 0, rdprop: 'title', ...cont,
    });
    r.query.pages.forEach((p) => {
      (p.redirects || []).forEach((x) => redirects.get(p.title)?.push(x.title));
    });
    cont = r.continue || null;
  } while (cont);
  redirects.forEach((list, t) => { byTitle.get(t).redirects = [...new Set(list)].sort(); });
}

if (problems.length) {
  problems.forEach((p) => console.error(`ERROR: ${p}`));
  process.exit(1);
}
fs.writeFileSync(FILE, `${JSON.stringify(cluster, null, 2)}\n`);
console.log(`pinned ${cluster.articles.length} articles, ${cluster.articles.reduce((n, a) => n + a.redirects.length, 0)} redirects`);
