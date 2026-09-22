/**
 * Infobox: key/value summary floated beside the article lead.
 *
 * Authoring model:
 *   first row, one cell  -> caption (title)
 *   one cell             -> sub-heading
 *   label | value        -> data row (extra cells are appended to the value)
 * @param {Element} block The infobox block element
 */
export default function decorate(block) {
  const table = document.createElement('table');
  const tbody = document.createElement('tbody');

  [...block.children].forEach((row, i) => {
    const cells = [...row.children].filter((c) => c.textContent.trim() || c.children.length);
    if (!cells.length) return;

    if (cells.length === 1) {
      if (i === 0) {
        const caption = document.createElement('caption');
        caption.append(...cells[0].childNodes);
        table.append(caption);
        return;
      }
      const tr = document.createElement('tr');
      const th = document.createElement('th');
      th.colSpan = 2;
      th.scope = 'colgroup';
      th.className = 'infobox-heading';
      th.append(...cells[0].childNodes);
      tr.append(th);
      tbody.append(tr);
      return;
    }

    const [label, ...values] = cells;
    const tr = document.createElement('tr');
    const th = document.createElement('th');
    th.scope = 'row';
    th.append(...label.childNodes);
    const td = document.createElement('td');
    values.forEach((v) => td.append(...v.childNodes));
    tr.append(th, td);
    tbody.append(tr);
  });

  table.append(tbody);
  block.replaceChildren(table);
}
