/*
 * Table Block
 * Adapted from the Block Collection table (https://www.aem.live/developer/block-collection/table)
 *
 * Authoring model:
 *   first row, one cell (other rows wider) -> caption
 *   next row                               -> column headers, unless variant `no-header`
 *   remaining rows                         -> data
 * Wide tables scroll inside the block, never the page.
 */

function buildCell(header) {
  const cell = document.createElement(header ? 'th' : 'td');
  if (header) cell.setAttribute('scope', 'col');
  return cell;
}

export default function decorate(block) {
  const table = document.createElement('table');
  const thead = document.createElement('thead');
  const tbody = document.createElement('tbody');
  const rows = [...block.children];

  const widest = Math.max(...rows.map((r) => r.children.length));
  if (widest > 1 && rows[0]?.children.length === 1) {
    const caption = document.createElement('caption');
    caption.append(...rows.shift().firstElementChild.childNodes);
    table.append(caption);
  }

  const header = !block.classList.contains('no-header') && rows.length > 1;
  if (header) table.append(thead);
  table.append(tbody);

  rows.forEach((row, i) => {
    const tr = document.createElement('tr');
    const isHeader = header && i === 0;
    (isHeader ? thead : tbody).append(tr);
    [...row.children].forEach((col) => {
      const cell = buildCell(isHeader);
      cell.append(...col.childNodes);
      tr.append(cell);
    });
  });

  block.replaceChildren(table);

  // a scrolling region must be reachable by keyboard; only wide tables become one
  requestAnimationFrame(() => {
    if (block.scrollWidth > block.clientWidth) {
      block.tabIndex = 0;
      block.setAttribute('role', 'region');
      block.setAttribute('aria-label', table.caption?.textContent.trim() || 'Table');
    }
  });
}
