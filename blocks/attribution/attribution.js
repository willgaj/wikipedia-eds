/**
 * Attribution: licence and source credit for adapted content (CC BY-SA).
 * Every cell becomes a paragraph; rows and cells carry no meaning.
 * @param {Element} block The attribution block element
 */
export default function decorate(block) {
  const content = [];
  block.querySelectorAll(':scope > div > div').forEach((cell) => {
    if (!cell.textContent.trim()) return;
    if (cell.querySelector(':scope > p')) {
      content.push(...cell.children);
    } else {
      const p = document.createElement('p');
      p.append(...cell.childNodes);
      content.push(p);
    }
  });
  block.setAttribute('role', 'note');
  block.setAttribute('aria-label', 'Attribution');
  block.replaceChildren(...content);
}
