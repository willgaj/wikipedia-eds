/**
 * Hatnote: short navigational note ("Main article: ...") under a heading.
 * Every cell becomes a paragraph; rows and cells carry no meaning.
 * @param {Element} block The hatnote block element
 */
export default function decorate(block) {
  const paragraphs = [];
  block.querySelectorAll(':scope > div > div').forEach((cell) => {
    if (!cell.textContent.trim()) return;
    if (cell.querySelector(':scope > p, :scope > ul, :scope > ol')) {
      paragraphs.push(...cell.children);
    } else {
      const p = document.createElement('p');
      p.append(...cell.childNodes);
      paragraphs.push(p);
    }
  });
  block.setAttribute('role', 'note');
  block.replaceChildren(...paragraphs);
}
