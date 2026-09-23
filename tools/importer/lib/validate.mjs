/**
 * Structural checks for imported articles.
 *   validateDaHtml     - the DA document before upload
 *   compareDelivered   - the uploaded document vs. the pipeline's .plain.html after preview
 * Errors block an upload; warnings are reported only.
 */
import { JSDOM } from 'jsdom';

const REQUIRED_METADATA = ['title', 'description', 'source-url', 'license'];

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
  const citations = doc.querySelector('.references:not(.notes)');
  const notes = doc.querySelector('.references.notes');
  return {
    sections: (doc.querySelector('main') ? doc.querySelectorAll('main > div') : doc.querySelectorAll('body > div')).length,
    h1: count(doc, 'h1'),
    h2: count(doc, 'h2'),
    h3: count(doc, 'h3'),
    blocks,
    links: count(doc, 'a[href]'),
    listItems: count(doc, 'li'),
    refLinks: refTargets(doc).length,
    citations: citations ? count(citations, 'ol > li') : 0,
    notes: notes ? count(notes, 'ol > li') : 0,
  };
}

/** @returns {{ errors: string[], warnings: string[], stats: object }} */
export function validateDaHtml(html) {
  const doc = parse(html);
  const errors = [];
  const warnings = [];
  const s = stats(doc);

  if (s.h1 !== 1) errors.push(`expected 1 <h1>, found ${s.h1}`);

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
    span: 'span', style: 'style, [style]', script: 'script', img: 'img, picture', table: 'table', id: '[id]',
  };
  Object.entries(leftovers).forEach(([name, sel]) => {
    const n = count(doc, sel);
    if (n) errors.push(`${n} leftover ${name} element(s)`);
  });
  const roots = new Set(blockRoots(doc));
  const stray = [...doc.querySelectorAll('main [class]')].filter((el) => !roots.has(el));
  if (stray.length) errors.push(`${stray.length} class attribute(s) outside block roots`);
  const redlinks = count(doc, 'a[href*="redlink=1"]');
  if (redlinks) errors.push(`${redlinks} red link(s) to non-existent articles`);
  const relative = count(doc, 'a[href^="./"], a[href^="../"]');
  if (relative) errors.push(`${relative} document-relative link(s)`);

  // inline reference markers must resolve to a list position (lettering as in the references block)
  const letter = (i) => (i >= 26 ? letter(Math.floor(i / 26) - 1) : '') + String.fromCharCode(97 + (i % 26));
  const letters = new Set([...Array(s.notes)].map((_, i) => letter(i)));
  const targets = refTargets(doc);
  const broken = targets.filter((t) => (t.startsWith('cite-') ? !(+t.slice(5) >= 1 && +t.slice(5) <= s.citations) : !letters.has(t.slice(5))));
  if (broken.length) errors.push(`${broken.length} reference link(s) without a target: ${[...new Set(broken)].slice(0, 10).join(', ')}`);
  const cited = new Set(targets);
  const uncited = [...Array(s.citations)].map((_, i) => i + 1).filter((n) => !cited.has(`cite-${n}`));
  if (uncited.length) warnings.push(`citations never cited on the page: ${uncited.join(', ')}`);

  const otherFragments = [...doc.querySelectorAll('a[href^="#"]')].map((a) => a.getAttribute('href')).filter((h) => !/^#(cite|note)-/.test(h));
  if (otherFragments.length) warnings.push(`fragment links other than references: ${[...new Set(otherFragments)].slice(0, 10).join(', ')}`);
  const tiny = [...doc.querySelectorAll('main > div > p')].filter((p) => p.textContent.trim().split(/\s+/).length <= 2 && !p.querySelector('a, sup'));
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
  ['sections', 'h1', 'h2', 'h3', 'links', 'listItems', 'refLinks', 'citations', 'notes'].forEach((k) => {
    if (sa[k] !== sb[k]) errors.push(`${k}: uploaded ${sa[k]}, delivered ${sb[k]}`);
  });
  const { metadata, ...uploadedBlocks } = sa.blocks;
  if (JSON.stringify(uploadedBlocks) !== JSON.stringify(sb.blocks)) {
    errors.push(`blocks: uploaded ${JSON.stringify(uploadedBlocks)}, delivered ${JSON.stringify(sb.blocks)}`);
  }
  if (JSON.stringify(refTargets(a)) !== JSON.stringify(refTargets(b))) errors.push('reference link sequence differs');
  return { errors, stats: sb };
}
