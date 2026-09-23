import { loadCSS, loadScript } from './aem.js';

/**
 * Renders maths stored as TeX in code spans: `$…$` inline, `$$…$$` displayed.
 * Temml (vendored in /scripts/vendor/temml, MIT) turns TeX into MathML, which browsers render
 * natively. It is loaded only on pages that contain maths. Without JavaScript the TeX stays
 * readable in the code span.
 */
const VENDOR = `${window.hlx?.codeBasePath || ''}/scripts/vendor/temml`;
const TEX = /^\$[\s\S]+\$$/;

export default async function decorateMath(main) {
  const codes = [...main.querySelectorAll('code')].filter((c) => TEX.test(c.textContent.trim()));
  if (!codes.length) return;

  await Promise.all([loadCSS(`${VENDOR}/Temml-Local.css`), loadScript(`${VENDOR}/temml.min.js`)]);
  await loadScript(`${VENDOR}/texvc.js`); // MediaWiki macros, defined on window.temml

  codes.forEach((code) => {
    const text = code.textContent.trim();
    const display = text.length > 4 && text.startsWith('$$') && text.endsWith('$$');
    const tex = display ? text.slice(2, -2) : text.slice(1, -1);
    const span = document.createElement('span');
    span.className = display ? 'math math-display' : 'math';
    try {
      // annotate keeps the TeX in the MathML (copy/paste, assistive tech)
      window.temml.render(tex, span, { displayMode: display, annotate: true, throwOnError: true });
      code.replaceWith(span);
    } catch (e) {
      // leave the TeX visible rather than a broken formula
      code.classList.add('math-error');
      code.title = e.message;
    }
  });
}
