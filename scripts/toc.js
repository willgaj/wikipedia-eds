/**
 * Table of contents for article pages, built from the h2/h3 headings (the delivery pipeline gives
 * headings their ids). Wide screens: sticky column beside the article; narrow screens: collapsible
 * bar under the header. Runs during decorateMain so the layout is final at first paint.
 */
const MIN_HEADINGS = 4; // as on Wikipedia
const WIDE = window.matchMedia('(width >= 1200px)');

function navHeight() {
  return parseInt(getComputedStyle(document.documentElement).getPropertyValue('--nav-height'), 10) || 64;
}

/**
 * @param {Element} main The page's main element (decorated sections)
 */
export default function buildToc(main) {
  const headings = [...main.querySelectorAll('.section > .default-content-wrapper > :is(h2, h3)')]
    .filter((h) => h.id && h.textContent.trim());
  if (headings.length < MIN_HEADINGS) return;

  const list = document.createElement('ol');
  const links = new Map();
  let parent = null; // the last h2 entry; h3 entries nest under it
  headings.forEach((h) => {
    const li = document.createElement('li');
    const a = document.createElement('a');
    a.href = `#${h.id}`;
    a.textContent = h.textContent.trim();
    li.append(a);
    links.set(h, a);
    if (h.tagName === 'H3' && parent) {
      let sub = parent.querySelector(':scope > ol');
      if (!sub) {
        sub = document.createElement('ol');
        parent.append(sub);
      }
      sub.append(li);
    } else {
      list.append(li);
      parent = li;
    }
  });

  const details = document.createElement('details');
  const summary = document.createElement('summary');
  summary.textContent = 'Contents';
  details.append(summary, list);
  const nav = document.createElement('nav');
  nav.className = 'toc';
  nav.setAttribute('aria-label', 'Contents');
  nav.append(details);
  main.prepend(nav);
  main.classList.add('has-toc');

  // open as a column on wide screens, closed as a bar on narrow ones
  const syncOpen = () => { details.open = WIDE.matches; };
  syncOpen();
  WIDE.addEventListener('change', syncOpen);
  list.addEventListener('click', (e) => {
    if (e.target.closest('a') && !WIDE.matches) details.open = false;
  });

  // mark the section being read
  let frame = 0;
  let active = null;
  const update = () => {
    frame = 0;
    const offset = navHeight() + 24;
    let current = null;
    headings.forEach((h) => { if (h.getBoundingClientRect().top <= offset) current = h; });
    if (current === active) return;
    if (active) links.get(active).removeAttribute('aria-current');
    active = current;
    if (!active) {
      if (WIDE.matches) nav.scrollTop = 0; // above the first section: show the list from the start
      return;
    }
    const a = links.get(active);
    a.setAttribute('aria-current', 'true');
    // keep the marked entry visible inside a long, scrolling column
    if (WIDE.matches && nav.scrollHeight > nav.clientHeight) {
      const top = a.offsetTop - nav.clientHeight / 2;
      nav.scrollTop = Math.max(top, 0);
    }
  };
  window.addEventListener('scroll', () => { if (!frame) frame = requestAnimationFrame(update); }, { passive: true });
  update();
}
