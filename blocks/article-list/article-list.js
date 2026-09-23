/**
 * Article list: card grid of articles from a query index.
 *
 * Authoring model: optional link to the index JSON; defaults to /query-index.json.
 * The index only contains published pages, so previewed-only articles do not appear.
 * @param {Element} block The article-list block element
 */

const DEFAULT_SOURCE = '/query-index.json';

function sourcePath(block) {
  const link = block.querySelector('a[href]');
  if (!link) return DEFAULT_SOURCE;
  const { pathname, search } = new URL(link.href, window.location);
  return `${pathname}${search}`;
}

function message(text) {
  const p = document.createElement('p');
  p.className = 'article-list-message';
  p.textContent = text;
  return p;
}

function card({ path, title, description }) {
  const li = document.createElement('li');
  const a = document.createElement('a');
  a.href = path;
  a.textContent = title;
  const h2 = document.createElement('h2');
  h2.append(a);
  li.append(h2);
  if (description) {
    const p = document.createElement('p');
    p.textContent = description;
    li.append(p);
  }
  return li;
}

export default async function decorate(block) {
  const source = sourcePath(block);
  block.replaceChildren(message('Loading articles…'));

  let rows;
  try {
    const resp = await fetch(source);
    if (!resp.ok) throw new Error(`${resp.status} ${source}`);
    ({ data: rows = [] } = await resp.json());
  } catch (error) {
    // eslint-disable-next-line no-console
    console.error('article-list: index unavailable', error);
    block.replaceChildren(message('The article list is unavailable right now.'));
    return;
  }

  const articles = rows
    .filter((r) => r.path && r.title)
    .sort((a, b) => a.title.localeCompare(b.title));
  if (!articles.length) {
    block.replaceChildren(message('No articles have been published yet.'));
    return;
  }

  const count = document.createElement('p');
  count.className = 'article-list-count';
  count.textContent = `${articles.length} ${articles.length === 1 ? 'article' : 'articles'}`;
  const ul = document.createElement('ul');
  ul.append(...articles.map(card));
  block.replaceChildren(count, ul);
}
