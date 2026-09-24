/**
 * Playwright helpers for the verify scripts. Uses an installed browser via `channel`
 * (default: Microsoft Edge), so no browser download is needed.
 */
import { chromium } from 'playwright-core';

export const VIEWPORTS = {
  desktop: { width: 1280, height: 900 },
  mobile: { width: 390, height: 844 },
};

export function launch(channel = 'msedge') {
  return chromium.launch({ channel });
}

/** Opens a page that records console errors, uncaught exceptions and 4xx/5xx responses. */
export async function openPage(browser, viewport, { route } = {}) {
  const page = await browser.newPage({ viewport });
  const problems = [];
  page.on('pageerror', (e) => problems.push(`exception: ${e.message}`));
  page.on('console', (m) => { if (m.type() === 'error') problems.push(`console: ${m.text()}`); });
  page.on('response', (r) => { if (r.status() >= 400) problems.push(`${r.status()} ${new URL(r.url()).pathname}`); });
  if (route) await page.route(route.url, route.handler);
  return { page, problems };
}

/** Scrolls to the bottom so lazily loaded sections decorate, then waits for block loading. */
export async function loadFully(page) {
  await page.evaluate(async () => {
    for (let y = 0; y < document.body.scrollHeight; y += 800) {
      window.scrollTo(0, y);
      // eslint-disable-next-line no-await-in-loop
      await new Promise((r) => { setTimeout(r, 30); });
    }
    window.scrollTo(0, 0);
  });
  await page.waitForFunction(() => [...document.querySelectorAll('.block')]
    .every((b) => b.dataset.blockStatus === 'loaded'), null, { timeout: 15000 }).catch(() => {});
}

/**
 * Prints PASS/FAIL/WARN lines and returns the number of failures.
 * A check given as [ok, detail, 'warn'] is reported but does not fail the run.
 */
export function report(label, checks) {
  let failures = 0;
  Object.entries(checks).forEach(([name, [ok, detail, level]]) => {
    const warnOnly = level === 'warn';
    if (!ok && !warnOnly) failures += 1;
    let status = 'PASS';
    if (!ok) status = warnOnly ? 'WARN' : 'FAIL';
    console.log(`  ${status}  ${label}  ${name}${detail !== undefined ? `: ${typeof detail === 'string' ? detail : JSON.stringify(detail)}` : ''}`);
  });
  return failures;
}
