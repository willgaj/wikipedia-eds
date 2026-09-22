/* global WebImporter */
/* eslint-disable no-console */

/**
 * AEM importer transform: Wikipedia article (Parsoid `?action=render` output) -> EDS document.
 *
 * Import a pinned revision so attribution can carry a permalink:
 *   https://en.wikipedia.org/w/index.php?title=<Title>&oldid=<revid>&action=render
 * `/wiki/<Title>?action=render` also works, but the attribution then has no revision.
 *
 * Content model:
 *   blocks: infobox, hatnote, references (notes), attribution, metadata
 *   default content: headings, paragraphs, lists, inline <sup> reference markers
 *   dropped: figures/images, audio, navboxes, portal/sister/side boxes, backlinks, hidden spans
 */

const WIKI_ORIGIN = 'https://en.wikipedia.org';
const LICENSE_URL = 'https://creativecommons.org/licenses/by-sa/4.0/';

/* Removed outright, with their content. */
const REMOVE_SELECTORS = [
  'style', 'link', 'meta', 'script', 'noscript',
  '[style*="display:none"]', '[style*="display: none"]',
  '.mw-empty-elt',
  '.shortdescription',
  'figure', 'audio', 'video', 'img', '.mw-file-element',
  '.navbox', '.navbox-styles', '.authority-control',
  '.portal-bar', '.side-box', '.sistersitebox',
  '.mw-cite-backlink',
  '.Z3988',
  '.mw-editsection',
];

/* Wrappers that carry no meaning once Wikipedia's CSS is gone. */
const UNWRAP_TAGS = ['span', 'div', 'cite', 'abbr', 'bdi', 'small', 'section', 'font', 'q', 'time', 'data'];

const RENAME_TAGS = { b: 'strong', i: 'em', s: 'del' };

/* Attributes the DA HTML contract allows on default content. */
const KEEP_ATTRS = { a: ['href'], td: ['colspan'], th: ['colspan'] };

function parseSource(url) {
  const u = new URL(url);
  const title = u.searchParams.get('title')
    || decodeURIComponent(u.pathname.replace(/^\/wiki\//, ''));
  return {
    title: title.replace(/_/g, ' '),
    wikiTitle: title.replace(/ /g, '_'),
    revision: u.searchParams.get('oldid') || '',
  };
}

function slugify(title) {
  return title.toLowerCase()
    .normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function unwrap(el) {
  el.replaceWith(...el.childNodes);
}

function rename(document, el, tag) {
  const n = document.createElement(tag);
  [...el.attributes].forEach((a) => n.setAttribute(a.name, a.value));
  n.append(...el.childNodes);
  el.replaceWith(n);
  return n;
}

function textOf(el) {
  return (el?.textContent || '').replace(/\s+/g, ' ').trim();
}

/** `#cite-12` for the default group, `#note-a` for lower-alpha notes. */
function refAnchor(group, label) {
  return group === 'lower-alpha' ? `note-${label}` : `cite-${label}`;
}

/** Inline Parsoid ref markers -> <sup><a href="#cite-N">[N]</a></sup>. */
function transformRefMarkers(document, root) {
  root.querySelectorAll('sup.mw-ref').forEach((sup) => {
    const a = sup.querySelector('a');
    const label = textOf(sup.querySelector('.mw-reflink-text') || sup).replace(/[[\]]/g, '');
    const group = a?.getAttribute('data-mw-group') || '';
    const out = document.createElement('sup');
    const link = document.createElement('a');
    link.href = `#${refAnchor(group, label)}`;
    link.textContent = `[${label}]`;
    out.append(link);
    sup.replaceWith(out);
  });

  // {{citation needed}} and friends: keep the flag as text, drop the link to the policy page
  root.querySelectorAll('sup.Inline-Template').forEach((sup) => {
    const out = document.createElement('sup');
    out.textContent = `[${textOf(sup).replace(/^\[|\]$/g, '')}]`;
    sup.replaceWith(out);
  });

  // Harvard short cites (#CITEREF..., #Autobiography) point at bibliography ids DA cannot carry
  root.querySelectorAll('a[href^="#CITEREF"], a.mw-selflink-fragment').forEach(unwrap);
}

function buildHatnotes(document, root) {
  root.querySelectorAll('.hatnote').forEach((hn) => {
    const cell = document.createElement('div');
    cell.append(...hn.childNodes);
    hn.replaceWith(WebImporter.Blocks.createBlock(document, { name: 'Hatnote', cells: [[cell]] }));
  });
}

/**
 * Infobox rows:
 *   row 1           -> title (single cell)
 *   label | value   -> data row
 *   single cell     -> sub-heading (e.g. "Engineering career"); dropped if nothing follows it
 * Image-only rows are dropped. Nested sub-infoboxes are flattened.
 */
function buildInfobox(document, root, report) {
  const boxes = [...root.querySelectorAll('table.infobox')];
  // Only the leading biography infobox; others (e.g. "External videos") are link boxes -> dropped
  const [main, ...rest] = boxes;
  rest.forEach((t) => t.remove());
  if (!main) return;

  const rows = [];
  let title = '';
  const walk = (table) => {
    [...table.rows].forEach((tr) => {
      if (tr.closest('table') !== table) return;
      const nested = tr.querySelector(':scope > td > table.infobox-subbox, :scope > td > table');
      if (nested) { walk(nested); return; }
      const th = tr.querySelector(':scope > th');
      const td = tr.querySelector(':scope > td');
      const cls = `${th?.className || ''} ${td?.className || ''}`;
      if (/infobox-image/.test(cls)) return;
      if (/infobox-above/.test(cls)) {
        // the outer box's "above" row is the title; a nested sub-box's is a sub-heading
        if (table === main) title = textOf(th || td);
        else rows.push([textOf(th || td)]);
        return;
      }
      if (/infobox-subheader/.test(cls)) {
        if (textOf(td)) rows.push(['Native name', td]);
        return;
      }
      if (/infobox-header/.test(cls) || (th && !td)) { rows.push([textOf(th)]); return; }
      if (th && td && textOf(td)) { rows.push([textOf(th), td]); return; }
      if (!th && td && textOf(td)) {
        // full-width data row with text only (sub-box titles land here)
        rows.push([textOf(td)]);
      }
    });
  };
  walk(main);

  // drop sub-headings with no data rows after them (e.g. "Signature" once its image is gone)
  const cleaned = rows.filter((r, i) => r.length === 2 || rows[i + 1]?.length === 2);
  const cells = [[title], ...cleaned.map((r) => r.map((c) => {
    if (typeof c === 'string') return c;
    const div = document.createElement('div');
    div.append(...c.childNodes);
    return div;
  }))];
  report.infoboxRows = cleaned.length;
  main.replaceWith(WebImporter.Blocks.createBlock(document, { name: 'Infobox', cells }));
}

function buildReferences(document, root, report) {
  report.references = {};
  root.querySelectorAll('.mw-references-wrap').forEach((wrap) => {
    const ol = wrap.querySelector('ol.mw-references, ol.references, ol');
    if (!ol) return;
    const group = ol.getAttribute('data-mw-group') || '';
    const items = [...ol.children].filter((li) => li.tagName === 'LI');
    const out = document.createElement('ol');
    items.forEach((li, i) => {
      // sanity check: list position must match the rendered label the inline markers use
      const expected = group === 'lower-alpha' ? String.fromCharCode(97 + i) : String(i + 1);
      const label = li.getAttribute('data-mw-footnote-number');
      if (label && label !== expected) console.warn(`reference label ${label} at position ${expected}`);
      const text = li.querySelector('.mw-reference-text') || li;
      const n = document.createElement('li');
      n.append(...text.childNodes);
      out.append(n);
    });
    report.references[group || 'default'] = items.length;
    const variants = group === 'lower-alpha' ? ['notes'] : [];
    wrap.replaceWith(WebImporter.Blocks.createBlock(document, { name: 'References', variants, cells: [[out]] }));
  });
}

/** Parsoid wraps headings in div.mw-heading; section breaks go before each h2. */
function normalizeHeadings(document, root) {
  root.querySelectorAll('.mw-heading').forEach((wrap) => {
    const h = wrap.querySelector('h1, h2, h3, h4, h5, h6');
    if (!h) { wrap.remove(); return; }
    [...h.attributes].forEach((a) => h.removeAttribute(a.name));
    wrap.replaceWith(h);
  });
}

function normalizeLinks(root) {
  root.querySelectorAll('a[href]').forEach((a) => {
    const href = a.getAttribute('href');
    if (href.startsWith('./')) a.setAttribute('href', `${WIKI_ORIGIN}/wiki/${href.slice(2)}`);
    else if (href.startsWith('/wiki/')) a.setAttribute('href', `${WIKI_ORIGIN}${href}`);
    else if (href.startsWith('//')) a.setAttribute('href', `https:${href}`);
  });
  root.querySelectorAll('a:not([href])').forEach(unwrap);
}

function cleanMarkup(document, root) {
  // comments (e.g. "PLEASE DO NOT CHANGE NATIONALITY")
  const walker = document.createTreeWalker(root, 128 /* NodeFilter.SHOW_COMMENT */);
  const comments = [];
  while (walker.nextNode()) comments.push(walker.currentNode);
  comments.forEach((c) => c.remove());

  Object.entries(RENAME_TAGS).forEach(([from, to]) => {
    root.querySelectorAll(from).forEach((el) => rename(document, el, to));
  });

  // unwrap innermost-first so nested wrappers all go
  UNWRAP_TAGS.forEach((tag) => {
    [...root.querySelectorAll(tag)].reverse().forEach(unwrap);
  });

  root.querySelectorAll('*').forEach((el) => {
    const keep = KEEP_ATTRS[el.tagName.toLowerCase()] || [];
    [...el.attributes].forEach((a) => { if (!keep.includes(a.name)) el.removeAttribute(a.name); });
  });

  // empty paragraphs / list items / emphasis left behind by removals
  root.querySelectorAll('p, li, strong, em, sup').forEach((el) => {
    if (!el.textContent.trim() && !el.querySelector('a, br')) el.remove();
  });
}

function buildAttribution(document, src) {
  const articleUrl = `${WIKI_ORIGIN}/wiki/${encodeURIComponent(src.wikiTitle)}`;
  const historyUrl = `${WIKI_ORIGIN}/w/index.php?title=${encodeURIComponent(src.wikiTitle)}&action=history`;
  const retrieved = new Date().toISOString().slice(0, 10);
  const revision = src.revision
    ? ` (<a href="${WIKI_ORIGIN}/w/index.php?title=${encodeURIComponent(src.wikiTitle)}&amp;oldid=${src.revision}">revision ${src.revision}</a>)`
    : '';
  const cell = document.createElement('div');
  cell.innerHTML = `<p>This article is adapted from <a href="${articleUrl}">${src.title}</a>${revision} on Wikipedia, `
    + `written by <a href="${historyUrl}">its contributors</a> and retrieved ${retrieved}. `
    + `It is licensed under <a href="${LICENSE_URL}">Creative Commons Attribution-ShareAlike 4.0</a>.</p>`
    + '<p>Changes: images, navigation boxes and some formatting were removed; reference and bibliography cross-links were simplified.</p>';
  return { block: WebImporter.Blocks.createBlock(document, { name: 'Attribution', cells: [[cell]] }), retrieved, articleUrl };
}

export default {
  transformDOM: ({ document, url, params }) => {
    const report = {};
    const src = parseSource(params?.originalURL || url);
    const root = document.querySelector('.mw-parser-output');
    if (!root || !root.hasAttribute('data-mw-parsoid-version')) {
      throw new Error('Expected Parsoid ?action=render output (.mw-parser-output[data-mw-parsoid-version])');
    }

    const description = textOf(root.querySelector('.shortdescription'));

    // order matters: blocks are built from source structure before the generic cleanup
    transformRefMarkers(document, root);
    WebImporter.DOMUtils.remove(root, REMOVE_SELECTORS);
    buildInfobox(document, root, report);
    buildHatnotes(document, root);
    buildReferences(document, root, report);
    normalizeHeadings(document, root);
    normalizeLinks(root);

    // blocks are <table>s from here on; clean everything around and inside them
    cleanMarkup(document, root);

    const main = document.createElement('main');
    const h1 = document.createElement('h1');
    h1.textContent = src.title;
    main.append(h1, ...root.childNodes);

    // one EDS section per h2
    main.querySelectorAll(':scope > h2').forEach((h2) => h2.before(document.createElement('hr')));

    const { block: attribution, retrieved, articleUrl } = buildAttribution(document, src);
    main.append(document.createElement('hr'), attribution);
    main.append(WebImporter.Blocks.getMetadataBlock(document, {
      Title: src.title,
      Description: description,
      Template: 'article',
      'Source-URL': articleUrl,
      'Source-Revision': src.revision,
      License: LICENSE_URL,
      Retrieved: retrieved,
    }));

    if (!src.revision) console.warn('No oldid in source URL: attribution has no revision permalink');
    console.log('import report', JSON.stringify(report));
    return main;
  },

  generateDocumentPath: ({ url, params }) => {
    const { title } = parseSource(params?.originalURL || url);
    return `/wiki/${slugify(title)}`;
  },
};
