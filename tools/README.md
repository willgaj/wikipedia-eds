# tools/

Node dev tooling for the Wikipedia → EDS port. Never served (`tools/` is in `.hlxignore`);
run output goes to `tools/output/` (git-ignored). Dependencies are root `devDependencies`.

## Prerequisites

- `npm ci`
- **DA / admin token** for anything that writes: `npx github:adobe-rnd/da-auth-helper token`
  opens an Adobe IMS login and caches the token in `~/.aem/da-token.json` (valid 24h).
  `DA_TOKEN` overrides it. The identity needs a role in the site access config
  (`admin`, or `publish` + `config` at minimum): unpublishing on this site always needs
  forced delete (the admin service gets 401 from DA, so it cannot confirm a source is gone).
- **Browser checks** use an installed browser through Playwright's `channel` (default `msedge`);
  nothing is downloaded. Pass `--channel chrome` to use Chrome instead.

## Import an article

```sh
npm run import -- "https://en.wikipedia.org/w/index.php?title=Nikola_Tesla&oldid=1372910045&action=render" \
  --upload --preview --check-delivered --publish
```

Pin the revision with `oldid`: the attribution block links to it. Steps, in order; each flag is optional:

1. fetch the Parsoid `?action=render` HTML (retries 5xx/429 with backoff: Wikipedia intermittently
   returns 500 for a page)
2. run `importer/import.js` (the content model: infobox, hatnote, references, attribution, metadata)
3. convert to a DA document (`importer/lib/da-html.mjs`) and validate it (`importer/lib/validate.mjs`);
   writes `tools/output/import/<path>.html`, `.report.json` and `.source.html` (the fetched input),
   and stops on errors (including block names with no code in `blocks/`)
4. `--upload` to DA, `--preview`, `--check-delivered` (compares `.plain.html` with what was uploaded),
   `--publish`

Only published pages appear in `/query-index.json`, and therefore on the homepage.

Set `WIKIMEDIA_USER_AGENT` to add contact details to the User-Agent
([policy](https://foundation.wikimedia.org/wiki/Policy:User-Agent_policy)); the default names the repo.

## Page lifecycle

```sh
npm run admin -- status    wiki/nikola-tesla
npm run admin -- publish   index nav footer
npm run admin -- unpublish some/page --delete-source
npm run admin -- reindex   nav
```

Paths take no leading slash (`index` is the homepage): Git Bash rewrites `/…` arguments into
Windows paths.

`reindex` deletes the path from every index and re-indexes it. Use it after changing an index
`include`: re-indexing alone never removes a row that stopped matching, and deleting alone also
drops the page from the sitemap.

## Verify in a browser

```sh
npm run verify:article -- https://main--wikipedia-eds--willgaj.aem.live/wiki/nikola-tesla
npm run verify:home                      # main preview against the real query index
npm run verify:home -- --mock 30         # same page, 30 made-up index rows (nothing on the site changes)
```

Both check desktop and mobile, write screenshots to `tools/output/verify/`, and exit 1 on failure.

Defaults target `willgaj/wikipedia-eds` on `main`; override with `AEM_ORG`, `AEM_SITE`, `AEM_REF`.
