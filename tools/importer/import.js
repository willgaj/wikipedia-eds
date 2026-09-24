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
 *   blocks: infobox, hatnote, table, references (notes), attribution, metadata
 *   default content: headings, paragraphs, lists, block quotes, inline <sup> reference markers,
 *     maths as TeX in code spans (`$…$` inline, `$$…$$` displayed; rendered by /scripts/math.js)
 *   dropped: figures/images, audio, navboxes, portal/sister/side boxes, backlinks, hidden spans
 *
 * Counts of what was converted are written to `params.report` for validation.
 */

const WIKI_ORIGIN = 'https://en.wikipedia.org';
const LICENSE_URL = 'https://creativecommons.org/licenses/by-sa/4.0/';

/* Removed with their content before anything is converted (maths/tables inside are not kept). */
const REMOVE_CONTAINERS = [
  'style', 'link', 'meta', 'script', 'noscript',
  '.mw-empty-elt',
  '.shortdescription',
  'figure', 'audio', 'video',
  '.navbox', '.navbox-styles', '.authority-control',
  '.portal-bar', '.side-box', '.sistersitebox', '.spoken-wikipedia',
  '.mw-cite-backlink',
  '.Z3988',
  '.mw-editsection',
  '.geo-nondefault', '.geo-multi-punct', // duplicate decimal coordinates
  '.locmap', // location map: its marker label and caption would outlive the removed image
  // citation maintenance/error notes for editors (the hidden ones via TemplateStyles)
  '.cs1-maint', '.cs1-hidden-error', '.cs1-visible-error',
  '.ambox', // maintenance banners ("This article needs more citations")
  '.sidebar', // navigation sidebars, like navboxes
  '.gallery', // image galleries: the captions would outlive the removed images
];

/* Removed after maths is converted: hidden spans hold the MathML copy and microformat data. */
const REMOVE_HIDDEN = ['[style*="display:none"]', '[style*="display: none"]', 'img', '.mw-file-element'];

/* Wrappers that carry no meaning once Wikipedia's CSS is gone. */
const UNWRAP_TAGS = ['span', 'div', 'cite', 'abbr', 'bdi', 'small', 'big', 'section', 'font', 'q', 'time', 'data'];

const RENAME_TAGS = { b: 'strong', i: 'em', s: 'del' };

/* Attributes the DA HTML contract allows on default content. */
const KEEP_ATTRS = { a: ['href'], td: ['colspan'], th: ['colspan'] };

// DL counts as a block: tables are unwrapped before definition lists are converted
const BLOCK_TAGS = /^(P|UL|OL|DL|BLOCKQUOTE|H[1-6]|TABLE|PRE)$/;

/* Environments that only work in display mode, whatever the source says. */
const DISPLAY_ENVS = /\\begin\{(align|alignat|gather|multline|equation|flalign)\*?\}/;

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
    .normalize('NFKD').replace(/\p{M}/gu, '')
    .replace(/['’]/g, '') // "Tesla's oscillator" -> teslas-oscillator
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

/** Moves an element's children into a new <div> (a block cell). */
function cellFrom(document, el, { brToSpace = false } = {}) {
  const div = document.createElement('div');
  div.append(...el.childNodes);
  if (brToSpace) div.querySelectorAll('br').forEach((br) => br.replaceWith(' '));
  return div;
}

/** Block-level children stay; runs of inline content are wrapped in <p>. */
function asBlocks(document, el) {
  const out = [];
  let p = null;
  [...el.childNodes].forEach((n) => {
    if (n.nodeType === 1 && BLOCK_TAGS.test(n.nodeName)) { p = null; out.push(n); return; }
    if (n.nodeType === 3 && !n.textContent.trim() && !p) return;
    if (!p) { p = document.createElement('p'); out.push(p); }
    p.append(n);
  });
  return out;
}

/** Heading level for a sub-heading inside the Parsoid <section> that contains `el` (min h3). */
function subheadingLevel(el) {
  const section = el.closest('section[data-mw-section-id]');
  const h = section?.querySelector(':scope > .mw-heading > h2, :scope > .mw-heading > h3, :scope > .mw-heading > h4, :scope > .mw-heading > h5');
  // never h2: that would start a new EDS section
  return Math.min(Math.max(h ? Number(h.tagName[1]) + 1 : 3, 3), 6);
}

function subheading(document, el, nodes) {
  const h = document.createElement(`h${subheadingLevel(el)}`);
  h.append(...nodes);
  return h;
}

/**
 * Anchor for a footnote: `#cite-12` (default group), `#note-a` (lower-alpha notes),
 * `#note-3` (a named group such as {{efn|group=note}}, labelled "note 3").
 * Must match the ids the references block generates for its variant.
 */
function refAnchor(group, label) {
  if (!group) return `cite-${label}`;
  if (group === 'lower-alpha') return `note-${label}`;
  return `note-${label.replace(/^\D+/, '')}`;
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

/**
 * <math> -> <code>$TeX$</code> (inline) or <code>$$TeX$$</code> (displayed), using the author's
 * TeX from data-mw. Displayed: marked block by the source, an environment that needs display mode,
 * or the only content of an indented line (Parsoid `dd`).
 */
function convertMath(document, root, report) {
  report.math = { inline: 0, display: 0, chem: 0 };
  root.querySelectorAll('.mwe-math-element').forEach((el) => {
    let mw = {};
    try { mw = JSON.parse(el.getAttribute('data-mw') || '{}'); } catch { /* use fallback */ }
    let tex = mw.body?.extsrc;
    if (!tex) {
      tex = (el.querySelector('math')?.getAttribute('alttext') || el.querySelector('img')?.getAttribute('alt') || '')
        .replace(/^\{\\(?:display|text)style\s*([\s\S]*)\}$/, '$1');
    }
    if (mw.name === 'chem' || mw.name === 'ce') {
      tex = `\\ce{${tex}}`; // needs the mhchem extension, which is not vendored yet
      report.math.chem += 1;
    }
    // `%` starts a TeX comment; strip before collapsing lines so it cannot swallow the rest
    tex = tex.split('\n')
      .map((l) => l.replace(/(^|[^\\])%.*$/, '$1'))
      .join(' ')
      .replace(/\s+/g, ' ')
      .trim();

    const parent = el.parentElement;
    const alone = parent?.tagName === 'DD'
      && [...parent.childNodes].every((n) => n === el || !n.textContent.replace(/[.,;:]/g, '').trim());
    const display = mw.attrs?.display === 'block'
      || el.classList.contains('mwe-math-element-block')
      || DISPLAY_ENVS.test(tex) || alone;

    const code = document.createElement('code');
    code.textContent = display ? `$$${tex}$$` : `$${tex}$`;
    el.replaceWith(code);
    report.math[display ? 'display' : 'inline'] += 1;
  });
}

/** Rectangular grid of a table with colspan/rowspan expanded. */
function tableGrid(table) {
  const grid = [];
  let spans = 0;
  [...table.rows].forEach((tr, r) => {
    grid[r] = grid[r] || [];
    let c = 0;
    [...tr.cells].forEach((cell) => {
      while (grid[r][c]) c += 1;
      const cs = Math.max(cell.colSpan || 1, 1);
      const rs = Math.max(cell.rowSpan || 1, 1);
      if (cs > 1 || rs > 1) spans += 1;
      for (let i = 0; i < rs; i += 1) {
        for (let j = 0; j < cs; j += 1) {
          grid[r + i] = grid[r + i] || [];
          // rowspan repeats the value (reads as intended); colspan leaves the extra cells empty
          grid[r + i][c + j] = { cell, header: cell.tagName === 'TH', empty: j > 0 };
        }
      }
      c += cs;
    });
  });
  const width = Math.max(...grid.map((row) => row.length));
  grid.forEach((row) => { for (let c = 0; c < width; c += 1) row[c] = row[c] || { empty: true }; });
  return { grid, width, spans };
}

/**
 * Wikitables -> `table` block.
 *   title row (one cell across the table)   -> caption (first block row, one cell)
 *   first row all <th>                      -> header row, else variant `no-header`
 *   <= 3 rows and > 4 columns               -> transposed (reads better on mobile and in DA)
 *   one column                              -> unwrapped to default content under a sub-heading
 * Collapsed tables are shown expanded.
 */
function convertTables(document, root, report) {
  report.tables = {
    blocks: 0,
    transposed: 0,
    unwrapped: 0,
    spans: 0,
    layout: 0,
    colourCoded: 0,
    headerRowsMerged: 0,
    emptyColumns: 0,
  };

  // Layout tables (neither data tables nor infoboxes: plaque text, legends, media boxes):
  // content becomes default content; a table left with nothing but its title row is dropped.
  [...root.querySelectorAll('table')].reverse().forEach((table) => {
    if (table.matches('.wikitable, .infobox') || table.closest('.infobox')) return;
    const rows = [...table.rows];
    const titleRow = rows.length > 1 && rows[0].cells.length === 1 && rows[0].cells[0].tagName === 'TH';
    const body = titleRow ? rows.slice(1) : rows;
    const out = body.flatMap((tr) => [...tr.cells].flatMap((cell) => asBlocks(document, cell)))
      .filter((el) => el.textContent.trim() || el.querySelector('code'));
    if (out.length && titleRow) {
      out.unshift(subheading(document, table, [...rows[0].cells[0].childNodes]));
    }
    table.replaceWith(...out);
    report.tables.layout += 1;
  });

  [...root.querySelectorAll('table.wikitable')].reverse().forEach((table) => {
    if (table.closest('.infobox')) return; // nested in an infobox: left for validation to flag
    // colours that tell cells with text apart (a legend elsewhere) do not survive the conversion;
    // colour-only swatch cells are handled below (their columns are empty and dropped)
    const colourOf = (c) => (c.getAttribute('bgcolor')
      || c.getAttribute('style')?.match(/background(?:-color)?:\s*([^;]+)/)?.[1] || '').trim().toLowerCase();
    const colours = new Set([...table.querySelectorAll('[bgcolor], [style*="background"]')]
      .filter((c) => c.textContent.trim())
      .map(colourOf));
    if (colours.size > 1) report.tables.colourCoded += 1;
    const { grid, spans } = tableGrid(table);
    let rows = grid;
    let caption = null;
    const titleRow = rows[0].every((slot) => slot.cell === rows[0][0].cell) && rows[0][0].header;
    if (rows.length > 1 && titleRow) {
      caption = rows[0][0].cell;
      rows = rows.slice(1);
    }
    // columns that only exist because a spanning title row was wider than the content
    const used = rows[0].map((_, c) => rows.some((row) => row[c].cell && !row[c].empty));
    rows = rows.map((row) => row.filter((_, c) => used[c]));

    // stacked header rows ("Phases" over "L1 L2 L3") -> one header row: "Phases L1", …
    let headRows = 0;
    while (headRows < rows.length - 1 && rows[headRows].every((s) => !s.cell || s.header)) {
      headRows += 1;
    }
    if (headRows > 1) {
      const merged = rows[0].map((_, c) => {
        const seen = new Set();
        const nodes = [];
        rows.slice(0, headRows).forEach((row) => {
          const { cell } = row[c];
          if (!cell || seen.has(cell) || !cell.textContent.trim()) return;
          seen.add(cell);
          if (nodes.length) nodes.push(document.createTextNode(' '));
          nodes.push(...[...cell.childNodes].map((n) => n.cloneNode(true)));
        });
        return { header: true, nodes };
      });
      rows = [merged, ...rows.slice(headRows)];
      report.tables.headerRowsMerged += 1;
    }
    // columns empty in every data row, e.g. colour swatches beside a cell naming the colour
    const dataRows = headRows ? rows.slice(1) : rows;
    const hasData = (s) => s.cell && !s.empty && (s.cell.textContent.trim() || s.cell.querySelector('code'));
    const keep = rows[0].map((_, c) => dataRows.some((row) => hasData(row[c])));
    if (keep.includes(false) && keep.includes(true)) {
      report.tables.emptyColumns += keep.filter((k) => !k).length;
      rows = rows.map((row) => row.filter((_, c) => keep[c]));
    }
    const width = rows[0].length;

    if (width <= 1) {
      const out = [];
      if (caption) out.push(subheading(document, table, [...caption.childNodes]));
      rows.forEach(([slot]) => {
        if (slot.cell && !slot.empty) out.push(...asBlocks(document, slot.cell));
      });
      table.replaceWith(...out);
      report.tables.unwrapped += 1;
      return;
    }

    if (rows.length <= 3 && width > 4) {
      rows = rows[0].map((_, c) => rows.map((row) => row[c]));
      report.tables.transposed += 1;
    }
    const header = rows[0].every((slot) => slot.header || slot.empty);
    const content = (slot) => {
      const div = document.createElement('div');
      if (slot.nodes) div.append(...slot.nodes); // merged header
      else if (slot.cell && !slot.empty) {
        div.append(...[...slot.cell.childNodes].map((n) => n.cloneNode(true)));
      }
      return div;
    };
    const cells = rows.map((row) => row.map(content));
    if (caption) cells.unshift([cellFrom(document, caption)]);
    const variants = header ? [] : ['no-header'];
    table.replaceWith(WebImporter.Blocks.createBlock(document, { name: 'Table', variants, cells }));
    report.tables.blocks += 1;
    report.tables.spans += spans;
  });
}

/**
 * `dl` from wikitext: `;term` alone is a pseudo-heading -> real sub-heading;
 * `;term` with `:definition` -> bold paragraph + paragraphs; `:indent` -> paragraph.
 */
function convertDefinitionLists(document, root) {
  [...root.querySelectorAll('dl')].reverse().forEach((dl) => {
    const items = [...dl.children];
    const onlyTerms = items.length && items.every((c) => c.tagName === 'DT');
    const out = [];
    items.forEach((item) => {
      if (item.tagName === 'DT') {
        if (onlyTerms) { out.push(subheading(document, dl, [...item.childNodes])); return; }
        const p = document.createElement('p');
        const strong = document.createElement('strong');
        strong.append(...item.childNodes);
        p.append(strong);
        out.push(p);
      } else {
        out.push(...asBlocks(document, item));
      }
    });
    dl.replaceWith(...out);
  });
}

/** {{quote}}: the citation line becomes the quote's last paragraph. */
function convertQuotes(document, root) {
  root.querySelectorAll('blockquote .templatequotecite').forEach((c) => {
    const p = document.createElement('p');
    p.append(...c.childNodes);
    c.replaceWith(p);
  });
}

function buildHatnotes(document, root) {
  root.querySelectorAll('.hatnote').forEach((hn) => {
    hn.replaceWith(WebImporter.Blocks.createBlock(document, { name: 'Hatnote', cells: [[cellFrom(document, hn)]] }));
  });
}

/**
 * Infobox rows:
 *   row 1           -> title; sub-header lines (native name, settlement type) as extra paragraphs
 *   label | value   -> data row (labels keep their markup, e.g. citation links)
 *   single cell     -> sub-heading (e.g. "Engineering career"); dropped if nothing follows it
 * Coordinates become one "Coordinates" row. Image-only rows are dropped.
 * Nested boxes are flattened.
 */
function buildInfobox(document, root, report) {
  const boxes = [...root.querySelectorAll('table.infobox')];
  // Only the leading infobox; others (e.g. "External videos") are link boxes -> dropped
  const [main, ...rest] = boxes;
  rest.forEach((t) => t.remove());
  if (!main) return;

  const rows = [];
  const title = document.createElement('div');
  const label = (el) => cellFrom(document, el, { brToSpace: true });
  const walk = (table) => {
    [...table.rows].forEach((tr) => {
      if (tr.closest('table') !== table) return;
      const nested = tr.querySelector(':scope > td > table');
      if (nested) { walk(nested); return; }
      const th = tr.querySelector(':scope > th');
      const td = tr.querySelector(':scope > td');
      const cls = `${th?.className || ''} ${td?.className || ''}`;
      // media rows (full width, no label): images and maps are dropped, so their captions go too.
      // Parsoid's file wrappers survive the <img> removal; labelled rows may hold icons (flags).
      const media = '[typeof*="mw:File"], .mw-file-description, .mw-kartographer-map, .infobox-caption';
      if (/infobox-image/.test(cls) || (!th && td?.querySelector(media))) return;
      const geo = tr.querySelector('.geo-default');
      if (geo) { rows.push(['Coordinates', cellFrom(document, geo)]); return; }
      if (/infobox-above/.test(cls)) {
        // the outer box's "above" row is the title; a nested box's is a sub-heading
        if (table === main) {
          const p = document.createElement('p');
          p.textContent = textOf(th || td);
          title.prepend(p);
        } else rows.push([label(th || td)]);
        return;
      }
      if (/infobox-subheader/.test(cls)) {
        if (textOf(td)) {
          const p = document.createElement('p');
          p.append(...td.childNodes);
          title.append(p);
        }
        return;
      }
      if (/infobox-header/.test(cls) || (th && !td)) { rows.push([label(th)]); return; }
      if (th && td && textOf(td)) { rows.push([label(th), cellFrom(document, td)]); return; }
      if (!th && td && textOf(td)) rows.push([label(td)]); // full-width text row
    });
  };
  walk(main);

  // drop sub-headings with no data rows after them (e.g. "Signature" once its image is gone)
  const cleaned = rows.filter((r, i) => r.length === 2 || rows[i + 1]?.length === 2);
  report.infoboxRows = cleaned.length;
  main.replaceWith(WebImporter.Blocks.createBlock(document, { name: 'Infobox', cells: [[title], ...cleaned] }));
}

/**
 * Reference lists -> `references` block. Variant by footnote group:
 *   default group            -> (none)          ids cite-1, cite-2, …
 *   lower-alpha ({{efn}})    -> notes           ids note-a, note-b, …
 *   named group (group=note) -> numbered-notes  ids note-1, note-2, …
 * Other groups, or two lists that would share ids, are reported for validation to reject.
 */
function buildReferences(document, root, report) {
  report.references = {};
  report.referenceProblems = [];
  const variantOf = (group) => {
    if (!group) return [];
    return group === 'lower-alpha' ? ['notes'] : ['numbered-notes'];
  };
  const seen = new Set();
  root.querySelectorAll('.mw-references-wrap').forEach((wrap) => {
    const ol = wrap.querySelector('ol.mw-references, ol.references, ol');
    if (!ol) return;
    const group = ol.getAttribute('data-mw-group') || '';
    const items = [...ol.children].filter((li) => li.tagName === 'LI');
    const variant = variantOf(group).join(' ') || 'default';
    if (seen.has(variant)) report.referenceProblems.push(`two reference lists share the ${variant} anchors (group "${group}")`);
    seen.add(variant);
    const out = document.createElement('ol');
    items.forEach((li, i) => {
      // list position must match the label the inline markers use (the block numbers by position)
      const label = (li.getAttribute('data-mw-footnote-number') || '').replace(/^\D+(?=\d)/, '');
      const expected = group === 'lower-alpha' ? String.fromCharCode(97 + i) : String(i + 1);
      if (label && label !== expected) {
        report.referenceProblems.push(`group "${group || 'default'}": label ${label} at position ${expected}`);
      }
      const text = li.querySelector('.mw-reference-text') || li;
      const n = document.createElement('li');
      n.append(...text.childNodes);
      out.append(n);
    });
    report.references[group || 'default'] = items.length;
    wrap.replaceWith(WebImporter.Blocks.createBlock(document, { name: 'References', variants: variantOf(group), cells: [[out]] }));
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

/** Heading id the delivery pipeline generates: lowercase, runs of other characters -> "-". */
function fragmentId(fragment) {
  let text = fragment;
  try { text = decodeURIComponent(fragment); } catch { /* keep as is */ }
  return text.replace(/_/g, ' ').toLowerCase().normalize('NFKD').replace(/\p{M}/gu, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/**
 * Link to an article imported into this site -> the local page (titles and their redirects come
 * from params.localArticles, built from articles.json). Everything else stays on Wikipedia.
 */
function localHref(href, params) {
  const m = href.match(/^https:\/\/en\.wikipedia\.org\/wiki\/([^?#]+)(?:#(.*))?$/);
  if (!m || !params?.localArticles) return null;
  let title = m[1];
  try { title = decodeURIComponent(title); } catch { /* keep as is */ }
  title = title.replace(/_/g, ' ');
  title = title.charAt(0).toUpperCase() + title.slice(1); // first letter is case-insensitive
  const path = params.localArticles[title];
  if (!path) return null;
  return `${params.siteOrigin || ''}${path}${m[2] ? `#${fragmentId(m[2])}` : ''}`;
}

function normalizeLinks(root, params, report) {
  report.localLinks = 0;
  // red links (article does not exist) -> plain text, as Wikipedia readers see them
  root.querySelectorAll('a.new, a[href*="redlink=1"]').forEach(unwrap);
  root.querySelectorAll('a[href]').forEach((a) => {
    const href = a.getAttribute('href');
    if (href.startsWith('./')) a.setAttribute('href', `${WIKI_ORIGIN}/wiki/${href.slice(2)}`);
    else if (href.startsWith('/wiki/')) a.setAttribute('href', `${WIKI_ORIGIN}${href}`);
    else if (href.startsWith('//')) a.setAttribute('href', `https:${href}`);
    const local = localHref(a.getAttribute('href'), params);
    if (local) {
      a.setAttribute('href', local);
      report.localLinks += 1;
    }
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

  // block quotes hold paragraphs, not bare text
  root.querySelectorAll('blockquote').forEach((bq) => bq.replaceChildren(...asBlocks(document, bq)));

  // empty paragraphs / list items / emphasis left behind by removals (<p><br></p> included)
  root.querySelectorAll('p, li, strong, em, sup').forEach((el) => {
    if (!el.textContent.trim() && !el.querySelector('a, code')
      && (el.tagName === 'P' || !el.querySelector('br'))) el.remove();
  });
}

/** Fallback description: the lead's first sentence, without reference markers (<= 160 chars). */
function leadSentence(main) {
  const lead = [...main.children].find((el) => el.tagName === 'P' && textOf(el).length > 20);
  if (!lead) return '';
  const clone = lead.cloneNode(true);
  clone.querySelectorAll('sup').forEach((s) => s.remove());
  const text = textOf(clone);
  const sentence = (text.match(/^.{20,}?[.!?](?=\s|$)/) || [text])[0];
  return sentence.length <= 160 ? sentence : `${sentence.slice(0, 159).replace(/\s+\S*$/, '')}…`;
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

    let description = textOf(root.querySelector('.shortdescription'));

    // order matters: everything that reads Parsoid structure (data-mw, <section>, .mw-heading,
    // table spans) runs before the generic cleanup
    transformRefMarkers(document, root);
    WebImporter.DOMUtils.remove(root, REMOVE_CONTAINERS);
    convertMath(document, root, report);
    WebImporter.DOMUtils.remove(root, REMOVE_HIDDEN);
    convertTables(document, root, report);
    buildInfobox(document, root, report);
    buildHatnotes(document, root);
    buildReferences(document, root, report);
    convertDefinitionLists(document, root);
    convertQuotes(document, root);
    normalizeHeadings(document, root);
    normalizeLinks(root, params, report);

    // blocks are <table>s from here on; clean everything around and inside them
    cleanMarkup(document, root);

    const main = document.createElement('main');
    const h1 = document.createElement('h1');
    h1.textContent = src.title;
    main.append(h1, ...root.childNodes);

    // runs of bare inline content left by unwrapped containers -> one paragraph each
    let run = null;
    [...main.childNodes].forEach((n) => {
      const inline = n.nodeType === 3 || /^(A|EM|STRONG|SUP|SUB|U|DEL|CODE|BR)$/.test(n.nodeName);
      if (!inline) { run = null; return; }
      if (n.nodeType === 3 && !n.textContent.trim() && !run) { n.remove(); return; }
      if (!run) { run = document.createElement('p'); n.before(run); }
      run.append(n);
    });

    if (!description) {
      description = leadSentence(main);
      report.descriptionFromLead = true;
    }

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
    if (params) params.report = report;
    return main;
  },

  generateDocumentPath: ({ url, params }) => {
    const { title } = parseSource(params?.originalURL || url);
    return `/wiki/${slugify(title)}`;
  },
};
