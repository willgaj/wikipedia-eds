/**
 * DA Source API and AEM Admin API helpers shared by tools/ scripts.
 *
 * Auth: DA_TOKEN env var, or the IMS token cached by
 *   npx github:adobe-rnd/da-auth-helper token   (writes ~/.aem/da-token.json, valid 24h)
 * The same token works for admin.da.live and admin.hlx.page.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const SITE = {
  org: process.env.AEM_ORG || 'willgaj',
  site: process.env.AEM_SITE || 'wikipedia-eds',
  ref: process.env.AEM_REF || 'main',
};

const TOKEN_FILE = path.join(os.homedir(), '.aem', 'da-token.json');

/** @param {'page'|'live'} tier */
export function hostUrl(tier = 'page') {
  return `https://${SITE.ref}--${SITE.site}--${SITE.org}.aem.${tier}`;
}

export function getToken() {
  if (process.env.DA_TOKEN) return process.env.DA_TOKEN;
  let cached;
  try {
    cached = JSON.parse(fs.readFileSync(TOKEN_FILE, 'utf8'));
  } catch { /* no cached token */ }
  if (!cached?.access_token || cached.expires_at < Date.now() + 60_000) {
    throw new Error(`No valid DA token. Run \`npx github:adobe-rnd/da-auth-helper token\` (caches ${TOKEN_FILE}) or set DA_TOKEN.`);
  }
  return cached.access_token;
}

/** Web path -> DA source file: `/` -> `index.html`, `/wiki/x` -> `wiki/x.html`. */
export function sourcePath(webPath) {
  return `${webPath.replace(/^\/+|\/+$/g, '') || 'index'}.html`;
}

async function call(method, url, init = {}) {
  const resp = await fetch(url, {
    method,
    ...init,
    headers: { Authorization: `Bearer ${getToken()}`, ...init.headers },
  });
  if (!resp.ok) {
    const reason = resp.headers.get('x-error');
    throw new Error(`${method} ${url} -> ${resp.status}${reason ? ` (${reason})` : ''}`);
  }
  if (resp.status === 204) return null;
  const type = resp.headers.get('content-type') || '';
  return type.includes('json') ? resp.json() : resp.text();
}

const daUrl = (webPath) => `https://admin.da.live/source/${SITE.org}/${SITE.site}/${sourcePath(webPath)}`;
const adminUrl = (op, webPath) => `https://admin.hlx.page/${op}/${SITE.org}/${SITE.site}/${SITE.ref}/${webPath.replace(/^\/+/, '')}`;

/** Upload a DA body-fragment document. The multipart field must be named `data`. */
export function putSource(webPath, html) {
  const form = new FormData();
  form.append('data', new Blob([html], { type: 'text/html' }), path.posix.basename(sourcePath(webPath)));
  return call('PUT', daUrl(webPath), { body: form });
}

export const deleteSource = (webPath) => call('DELETE', daUrl(webPath));
export const status = (webPath) => call('GET', adminUrl('status', webPath));
export const preview = (webPath) => call('POST', adminUrl('preview', webPath));
export const publish = (webPath) => call('POST', adminUrl('live', webPath));

/**
 * Take a page off live and preview. On this site the admin service sees DA sources as 401,
 * so it can never confirm a source is gone: every delete is a forced delete and needs the
 * publish role or higher. Order: DA source (optional), live, preview.
 */
export async function unpublish(webPath, { removeSource = false } = {}) {
  // 404 = never published / already removed; keep going so a partial run can be repeated
  const gone = (e) => { if (!/ -> 404\b/.test(e.message)) throw e; };
  if (removeSource) await deleteSource(webPath).catch(gone);
  await call('DELETE', adminUrl('live', webPath)).catch(gone);
  await call('DELETE', adminUrl('preview', webPath)).catch(gone);
}

/**
 * Bring a page's rows in line with the current index config.
 * POST alone never removes a row for a path that stopped matching; DELETE removes the path from
 * every index, including the internal sitemap index, so re-POST to restore what still matches.
 */
export async function reindex(webPath) {
  await call('DELETE', adminUrl('index', webPath));
  return call('POST', adminUrl('index', webPath));
}
