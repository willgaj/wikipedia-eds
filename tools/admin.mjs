#!/usr/bin/env node
/**
 * Page lifecycle commands for the DA-backed site.
 *
 *   npm run admin -- status    <path...>
 *   npm run admin -- preview   <path...>
 *   npm run admin -- publish   <path...>
 *   npm run admin -- unpublish <path...> [--delete-source]
 *   npm run admin -- reindex   <path...>
 *
 * Paths are web paths; the leading slash is optional (`index` is the homepage). In Git Bash,
 * leave it off: MSYS rewrites `/wiki/x` into `C:/.../Git/wiki/x` before node sees it.
 */
import { parseArgs } from 'node:util';
import {
  status, preview, publish, unpublish, reindex,
} from './lib/admin.mjs';

const { values: opts, positionals: [command, ...paths] } = parseArgs({
  allowPositionals: true,
  options: { 'delete-source': { type: 'boolean', default: false } },
});

function toWebPath(arg) {
  if (/^[A-Za-z]:[\\/]/.test(arg)) {
    throw new Error('looks like a path Git Bash rewrote; drop the leading slash (wiki/page, index) or set MSYS_NO_PATHCONV=1');
  }
  const p = `/${arg.replace(/^\/+/, '')}`;
  return p === '/index' ? '/' : p;
}

const commands = {
  status: async (p) => {
    const s = await status(p);
    return `preview ${s.preview?.status}, live ${s.live?.status}, permissions ${JSON.stringify(s.live?.permissions)}`;
  },
  preview: async (p) => { await preview(p); return 'previewed'; },
  publish: async (p) => { await publish(p); return 'published'; },
  unpublish: async (p) => {
    await unpublish(p, { removeSource: opts['delete-source'] });
    return opts['delete-source'] ? 'DA source deleted, unpublished, preview removed' : 'unpublished, preview removed';
  },
  reindex: async (p) => {
    const r = await reindex(p);
    return r.results.map((x) => `${x.name}=${x.record ? 'indexed' : x.message}`).join(' | ');
  },
};

if (!commands[command] || !paths.length) {
  console.error(`usage: npm run admin -- <${Object.keys(commands).join('|')}> <path...> [--delete-source]`);
  process.exit(2);
}

let failed = 0;
for (const arg of paths) {
  try {
    const p = toWebPath(arg);
    console.log(`${p}: ${await commands[command](p)}`);
  } catch (e) {
    failed += 1;
    console.error(`${arg}: ${e.message}`);
  }
}
process.exit(failed ? 1 : 0);
