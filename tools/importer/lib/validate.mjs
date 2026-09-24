/**
 * Structural checks for imported articles.
 *   validateDaHtml     - the DA document before upload
 *   compareDelivered   - the uploaded document vs. the pipeline's .plain.html after preview
 * Errors block an upload; warnings are reported only.
 */
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';

const REQUIRED_METADATA = ['title', 'description', 'source-url', 'license'];

// Block names that resolve to code: folders in /blocks plus the pipeline-consumed metadata blocks.
// Anything else renders as unstyled divs (e.g. a source <table> turned into a "block").
const BLOCKS_DIR = fileURLToPath(new URL('../../../blocks/', import.meta.url));
const KNOWN_BLOCKS = new Set([
  ...fs.readdirSync(BLOCKS_DIR, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name),
  'metadata', 'section-metadata',
]);

const parse = (html) => new JSDOM(html).window.document;
const count = (root, selector) => root.querySelectorAll(selector).length;

/** Top-level blocks: <div class> directly inside a section div. */
function blockRoots(doc) {
  const sections = doc.querySelector('main') ? doc.querySelectorAll('main > div') : doc.querySelectorAll('body > div');
  return [...sections].flatMap((s) => [...s.children].filter((c) => c.tagName === 'DIV' && c.className));
}

function refTargets(doc) {
  return [...doc.querySelectorAll('a[href^="#cite-"], a[href^="#note-"]')].map((a) => a.getAttribute('href').slice(1));
}

function stats(doc) {
  const blocks = {};
  blockRoots(doc).forEach((b) => { blocks[b.className] = (blocks[b.className] || 0) + 1; });
  const refBlocks = blockRoots(doc).filter((b) => b.classList.contains('references'));
  const isNotes = (b) => b.classList.contains('notes') || b.classList.contains('numbered-notes');
  const items = (list) => list.reduce((n, b) => n + count(b, 'ol > li'), 0);
  const tables = blockRoots(doc).filter((b) => b.classList.contains('table'));
  return {
    mathCodes: [...doc.querySelectorAll('code')].filter((c) => /^\$[\s\S]+\$$/.test(c.textContent.trim())).length,
    tableCells: tables.reduce((n, t) => n + t.querySelectorAll(':scope > div > div').length, 0),
    sections: (doc.querySelector('main') ? doc.querySelectorAll('main > div') : doc.querySelectorAll('body > div')).length,
    h1: count(doc, 'h1'),
    h2: count(doc, 'h2'),
    h3: count(doc, 'h3'),
    h4: count(doc, 'h4'),
    blocks,
    links: count(doc, 'a[href]'),
    listItems: count(doc, 'li'),
    refLinks: refTargets(doc).length,
    citations: items(refBlocks.filter((b) => !isNotes(b))),
    notes: items(refBlocks.filter(isNotes)),
  };
}

/**
 * @param {string} html DA document
 * @param {object} [expected] the transform's report (counts of converted maths and tables)
 * @returns {{ errors: string[], warnings: string[], stats: object }}
 */
export function validateDaHtml(html, expected = {}) {
  const doc = parse(html);
  const errors = [];
  const warnings = [];
  const s = stats(doc);

  // content loss: everything the transform converted must still be in the document
  if (expected.math) {
    const want = expected.math.inline + expected.math.display;
    if (s.mathCodes !== want) errors.push(`maths: converted ${want}, document has ${s.mathCodes}`);
    if (expected.math.chem) warnings.push(`${expected.math.chem} chemistry formula(s): need mhchem, not vendored`);
  }
  if (expected.tables) {
    const tableBlocks = Object.entries(s.blocks)
      .filter(([k]) => k.split(' ')[0] === 'table')
      .reduce((n, [, v]) => n + v, 0);
    if (tableBlocks !== expected.tables.blocks) {
      errors.push(`tables: converted ${expected.tables.blocks}, document has ${tableBlocks}`);
    }
    if (expected.tables.transposed) {
      warnings.push(`${expected.tables.transposed} table(s) transposed (wide and short): check them`);
    }
    if (expected.tables.spans) warnings.push(`${expected.tables.spans} merged cell(s) split in tables`);
    if (expected.tables.layout) warnings.push(`${expected.tables.layout} layout table(s) unwrapped to content`);
    if (expected.tables.colourCoded) {
      warnings.push(`${expected.tables.colourCoded} table(s) use cell colours, which are lost: check for meaning carried by colour`);
    }
  }
  if (expected.descriptionFromLead) warnings.push('no short description: using the lead\'s first sentence');

  if (s.h1 !== 1) errors.push(`expected 1 <h1>, found ${s.h1}`);

  const unknownBlocks = Object.keys(s.blocks).filter((c) => !KNOWN_BLOCKS.has(c.split(' ')[0]));
  if (unknownBlocks.length) {
    errors.push(`unknown block(s), no code in /blocks: ${unknownBlocks.map((c) => c.slice(0, 40)).join(', ')}`);
  }

  // licensing: attribution and source metadata are required on every page
  const meta = {};
  doc.querySelectorAll('.metadata > div').forEach((row) => {
    const [k, v] = row.children;
    if (k) meta[k.textContent.trim().toLowerCase()] = v?.textContent.trim();
  });
  if (!doc.querySelector('.metadata')) errors.push('missing metadata block');
  REQUIRED_METADATA.filter((k) => !meta[k]).forEach((k) => errors.push(`metadata missing "${k}"`));
  const attribution = doc.querySelector('.attribution');
  if (!attribution) errors.push('missing attribution block');
  else {
    if (!attribution.querySelector('a[href^="https://en.wikipedia.org/"]')) errors.push('attribution has no link to the source article');
    if (!attribution.querySelector('a[href^="https://creativecommons.org/licenses/by-sa/"]')) errors.push('attribution has no CC BY-SA licence link');
  }

  // markup the DA contract forbids or the transform should have removed
  const leftovers = {
    span: 'span',
    style: 'style, [style]',
    script: 'script',
    img: 'img, picture',
    table: 'table',
    id: '[id]',
    'definition list': 'dl, dt, dd',
    big: 'big',
    math: 'math',
  };
  Object.entries(leftovers).forEach(([name, sel]) => {
    const n = count(doc, sel);
    if (n) errors.push(`${n} leftover ${name} element(s)`);
  });
  const roots = new Set(blockRoots(doc));
  const stray = [...doc.querySelectorAll('main [class]')].filter((el) => !roots.has(el));
  if (stray.length) errors.push(`${stray.length} class attribute(s) outside block roots`);
  const codeLinks = count(doc, 'code a');
  if (codeLinks) errors.push(`${codeLinks} link(s) inside code spans (the pipeline drops them)`);
  const redlinks = count(doc, 'a[href*="redlink=1"]');
  if (redlinks) errors.push(`${redlinks} red link(s) to non-existent articles`);
  const relative = count(doc, 'a[href^="./"], a[href^="../"]');
  if (relative) errors.push(`${relative} document-relative link(s)`);

  // inline reference markers must resolve to a list position (lettering as in the references block)
  // ids each references block will generate (see blocks/references): cite-N, note-a…, note-N
  const letter = (i) => (i >= 26 ? letter(Math.floor(i / 26) - 1) : '') + String.fromCharCode(97 + (i % 26));
  const anchors = new Set();
  const variants = new Set();
  blockRoots(doc).filter((b) => b.classList.contains('references')).forEach((b) => {
    const lettered = b.classList.contains('notes');
    const prefix = lettered || b.classList.contains('numbered-notes') ? 'note' : 'cite';
    const kind = `${prefix}-${lettered ? 'a' : '1'}`;
    if (variants.has(kind)) errors.push(`two references blocks generate the same anchors (${prefix}-…)`);
    variants.add(kind);
    [...b.querySelectorAll('ol > li')].forEach((_, i) => anchors.add(`${prefix}-${lettered ? letter(i) : i + 1}`));
  });
  (expected.referenceProblems || []).forEach((p) => errors.push(`references: ${p}`));
  const targets = refTargets(doc);
  const broken = targets.filter((t) => !anchors.has(t));
  if (broken.length) errors.push(`${broken.length} reference link(s) without a target: ${[...new Set(broken)].slice(0, 10).join(', ')}`);
  const cited = new Set(targets);
  const uncited = [...Array(s.citations)].map((_, i) => i + 1).filter((n) => !cited.has(`cite-${n}`));
  if (uncited.length) warnings.push(`citations never cited on the page: ${uncited.join(', ')}`);

  const otherFragments = [...doc.querySelectorAll('a[href^="#"]')].map((a) => a.getAttribute('href')).filter((h) => !/^#(cite|note)-/.test(h));
  if (otherFragments.length) warnings.push(`fragment links other than references: ${[...new Set(otherFragments)].slice(0, 10).join(', ')}`);
  // short paragraphs that may be leaked fragments; lead-ins ("Further:") and bold pseudo-headings
  // are ordinary text
  const tiny = [...doc.querySelectorAll('main > div > p')].filter((p) => {
    const text = p.textContent.trim();
    const boldOnly = p.children.length === 1 && p.firstElementChild.tagName === 'STRONG'
      && p.firstElementChild.textContent.trim() === text;
    return text.split(/\s+/).length <= 2 && !p.querySelector('a, sup, code')
      && !text.endsWith(':') && !boldOnly;
  });
  if (tiny.length) warnings.push(`${tiny.length} very short paragraph(s), e.g. "${tiny[0].textContent.trim()}" (leaked fragments?)`);

  return { errors, warnings, stats: s };
}

/**
 * The pipeline reshapes markup (e.g. <sup><a> becomes <a><sup>, adjacent markers merge into one
 * <sup>, the metadata block becomes <meta> tags), so compare what must survive, not raw HTML.
 */
export function compareDelivered(daHtml, plainHtml) {
  const a = parse(daHtml);
  const b = parse(plainHtml);
  const sa = stats(a);
  const sb = stats(b);
  const errors = [];
  ['sections', 'h1', 'h2', 'h3', 'h4', 'links', 'listItems', 'refLinks', 'citations', 'notes',
    'mathCodes', 'tableCells'].forEach((k) => {
    if (sa[k] !== sb[k]) errors.push(`${k}: uploaded ${sa[k]}, delivered ${sb[k]}`);
  });
  const { metadata, ...uploadedBlocks } = sa.blocks;
  if (JSON.stringify(uploadedBlocks) !== JSON.stringify(sb.blocks)) {
    errors.push(`blocks: uploaded ${JSON.stringify(uploadedBlocks)}, delivered ${JSON.stringify(sb.blocks)}`);
  }
  if (JSON.stringify(refTargets(a)) !== JSON.stringify(refTargets(b))) errors.push('reference link sequence differs');
  return { errors, stats: sb };
}
