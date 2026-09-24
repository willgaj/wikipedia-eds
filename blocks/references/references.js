/**
 * References: numbered citation list; inline markers link to it.
 *
 * Authoring model: one list (or one paragraph per entry) anywhere in the block.
 * Anchors come from list position: `#cite-1`, `#cite-2`, ...
 * Variant `notes`: lettered list, anchors `#note-a`, `#note-b`, ...
 * Variant `numbered-notes`: numbered list, anchors `#note-1`, `#note-2`, ...
 * Inline markers are authored as superscript links: <sup><a href="#cite-12">[12]</a></sup>
 * @param {Element} block The references block element
 */

function letter(i) {
  // a..z, aa..az, ...
  let n = i;
  let s = '';
  do {
    s = String.fromCharCode(97 + (n % 26)) + s;
    n = Math.floor(n / 26) - 1;
  } while (n >= 0);
  return s;
}

function collectItems(block) {
  const lists = [...block.querySelectorAll('ol, ul')].filter((l) => !l.parentElement.closest('ol, ul'));
  if (lists.length) return lists.flatMap((l) => [...l.children].filter((li) => li.tagName === 'LI'));
  // fallback: authors pasted paragraphs instead of a list
  return [...block.querySelectorAll('p')].map((p) => {
    const li = document.createElement('li');
    li.append(...p.childNodes);
    return li;
  });
}

function addBacklinks(li, id) {
  const markers = [...document.querySelectorAll(`main a[href="#${id}"]`)];
  if (!markers.length) return;
  const back = document.createElement('span');
  back.className = 'references-backlinks';
  markers.forEach((marker, k) => {
    marker.id = `${id}-ref-${k}`;
    const a = document.createElement('a');
    a.href = `#${marker.id}`;
    a.textContent = markers.length === 1 ? '↑' : letter(k);
    a.setAttribute('aria-label', `Back to citation ${k + 1}`);
    back.append(a);
  });
  li.prepend(back);
}

export default function decorate(block) {
  const notes = block.classList.contains('notes');
  const prefix = notes || block.classList.contains('numbered-notes') ? 'note' : 'cite';
  const ol = document.createElement('ol');
  if (notes) ol.type = 'a';

  collectItems(block).forEach((li, i) => {
    const id = `${prefix}-${notes ? letter(i) : i + 1}`;
    li.id = id;
    addBacklinks(li, id);
    ol.append(li);
  });

  block.replaceChildren(ol);
}
