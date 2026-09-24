/**
 * Importer output (block <table>s, <hr> section breaks) -> DA body-fragment HTML
 * (canonical div-form blocks, one <div> per section).
 */

/** `References (notes)` -> `references notes` */
function blockClass(header) {
  const slug = (s) => s.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  // a leftover source table (not built by the transform) can have any header text:
  // give it a name the validator will reject instead of failing here
  const m = header.trim().match(/^([^(]+)(?:\(([^)]*)\))?$/);
  if (!m) return `unconverted-${slug(header).slice(0, 40)}`;
  const [, name, variants = ''] = m;
  return [slug(name), ...variants.split(',').map(slug)].filter(Boolean).join(' ');
}

function tableToBlock(document, table) {
  const [head, ...rows] = [...table.rows];
  const block = document.createElement('div');
  block.className = blockClass(head.textContent);
  rows.forEach((tr) => {
    const row = document.createElement('div');
    [...tr.cells].forEach((td) => {
      const cell = document.createElement('div');
      cell.append(...td.childNodes);
      // createBlock wraps DOM cells in a <div>; the cell div already plays that role
      if (cell.childNodes.length === 1 && cell.firstChild.nodeName === 'DIV') {
        cell.firstChild.replaceWith(...cell.firstChild.childNodes);
      }
      row.append(cell);
    });
    block.append(row);
  });
  return block;
}

/**
 * @param {Document} document
 * @param {Element} main importer transform result
 * @returns {string} DA document HTML
 */
export default function toDaHtml(document, main) {
  main.querySelectorAll('table').forEach((t) => t.replaceWith(tableToBlock(document, t)));

  const sections = [[]];
  [...main.childNodes].forEach((node) => {
    if (node.nodeName === 'HR') sections.push([]);
    else if (node.nodeType !== 3 || node.textContent.trim()) sections.at(-1).push(node);
  });

  const body = sections.filter((s) => s.length).map((nodes) => {
    const div = document.createElement('div');
    nodes.forEach((n) => {
      if (n.nodeType !== 3) { div.append(n); return; }
      // stray text at section level (import.js should already have wrapped it)
      const p = document.createElement('p');
      p.textContent = n.textContent.trim();
      div.append(p);
    });
    return div.outerHTML;
  }).join('\n');

  return `<body><header></header><main>${body}</main><footer></footer></body>\n`;
}
