# AGENTS.md

Edge Delivery Services. Read a block first. Omissions are in the repo or known.

## Avoid
- `scripts/aem.js` is vendored. Never edit.
- Markup comes from the backend. `curl localhost:3000/x.plain.html` first.
- `buildAutoBlocks` rewrites content before your block runs.
- Authors omit and add cells. Decorate defensively.
- No build step; devDependencies only.
- Scope CSS to `.blockname`; `-wrapper`/`-container` are section classes.
- `fragment/fragment.js` is the only cross-block import. Otherwise use `/scripts/`.

## Outdated
- `fstab.yaml`, `helix-query.yaml`, `paths.json` are retired. Config lives at tools.aem.live.

## Remember
- `npx -y @adobe/aem-cli up`: local code, previewed content.
- Merging `main` ships code; content publishes separately.
- A PR without a `{branch}--wikipedia-eds--willgaj.aem.page/{path}` link is rejected.
- All committed files are served. Use `.hlxignore`.
- Import, publish, verify: `npm run import|admin|verify:*`. See `tools/README.md`.
- Skills: `/plugin marketplace add adobe/skills`, then `aem-edge-delivery-services` (24 skills, incl. `docs-search`).

## Project-specific notes
- This is an Adobe Edge Delivery Services (EDS) project using document-based authoring
- The goal is to create a POC port of the Wikipedia site (https://www.wikipedia.org/) to an EDS site

## Project URLs

**This is an EDS (Edge Delivery Services) project. Not AEM 6.5. No Java, no Maven, no Sling, no JCR.**

## Environments
- Local dev: http://localhost:3000 (`aem up`)
- Importer UI: http://localhost:3001 (`aem import`)
- Preview: https://main--wikipedia-eds--willgaj.aem.page
- Live: https://main--wikipedia-eds--willgaj.aem.live
- Repo: https://github.com/willgaj/wikipedia-eds

## Content source (Document Authoring)
- Authoring UI: https://da.live/#/willgaj/wikipedia-eds
- Edit a doc: https://da.live/edit#/willgaj/wikipedia-eds/<path>
- Content API root: https://content.da.live/willgaj/wikipedia-eds/
- DA docs: https://docs.da.live/
- Config is managed by the Config Service, NOT fstab.yaml. Do not create
or edit fstab.yaml.

## Admin API (https://www.aem.live/docs/admin.html)
- Site config: https://admin.hlx.page/config/willgaj/sites/wikipedia-eds.json
- Access config: https://admin.hlx.page/config/willgaj/sites/wikipedia-eds/access.json
- Status: https://admin.hlx.page/status/willgaj/wikipedia-eds/main/<path>
- Preview: https://admin.hlx.page/preview/willgaj/wikipedia-eds/main/<path>
- Publish: https://admin.hlx.page/live/willgaj/wikipedia-eds/main/<path>
- Token login: https://admin.hlx.page/login
- Config UI: https://tools.aem.live/tools/site-admin/index.html
- Never commit an auth_token. Read it from the environment.

## Debugging
- Rendered block markup: https://main--wikipedia-eds--willgaj.aem.page/<path>.plain.html
- Content index: https://main--wikipedia-eds--willgaj.aem.live/query-index.json

## Reference docs — consult these before inventing patterns
- Docs home: https://www.aem.live/docs/
- DA developer tutorial: https://www.aem.live/developer/da-tutorial
- Block collection: https://www.aem.live/developer/block-collection
- Exploring blocks: https://www.aem.live/docs/exploring-blocks
- Anatomy of a project: https://www.aem.live/docs/project-anatomy
- Importer: https://github.com/adobe/helix-importer
- AI agent guidance: https://www.aem.live/developer/ai-coding-agents

## Source content
- Article body only (use this, not the full page):
  https://en.wikipedia.org/wiki/<Article>?action=render
- MediaWiki API: https://en.wikipedia.org/w/api.php
- User-Agent policy (required): https://foundation.wikimedia.org/wiki/Policy:User-Agent_policy
- Reuse terms: https://en.wikipedia.org/wiki/Wikipedia:Reusing_Wikipedia_content
- Content is CC BY-SA. Every imported page must carry attribution and a
link to the source article.