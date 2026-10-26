/* End-to-end smoke tests. Requires a headed Chromium because the app needs WebGL2.
   Run with: npm run test:e2e (uses xvfb-run). */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { createGameServer } from '../server/server.mjs';

const ENABLED = process.env.E2E === '1';
const maybe = ENABLED ? test : test.skip;
const quiet = { error() {}, warn() {}, log() {} };

let app;
let base;
let browser;

before(async () => {
  if (!ENABLED) return;
  app = createGameServer({ log: quiet, env: {} });
  const address = await app.listen(0, '127.0.0.1');
  base = `http://127.0.0.1:${address.port}`;
  browser = await chromium.launch({
    headless: false,
    args: ['--use-gl=angle', '--use-angle=gl', '--ignore-gpu-blocklist'],
  });
});

after(async () => {
  if (!ENABLED) return;
  await browser?.close();
  await app?.close();
});

async function openPage(context, query = '?nosw=1') {
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (err) => errors.push(`pageerror: ${err.message}`));
  page.on('console', (msg) => {
    if (msg.type() === 'error' && !msg.text().includes('Failed to load resource')) {
      errors.push(`console: ${msg.text()}`);
    }
  });
  await page.goto(base + '/' + query, { waitUntil: 'networkidle' });
  await page.waitForFunction(() => window.__goVoid?.state?.booted, null, { timeout: 20_000 });
  return { page, errors };
}

async function tapIntersection(page, index) {
  const point = await page.evaluate((i) => window.__goVoid.intersectionScreen(i), index);
  assert.ok(point, 'intersection should project on screen');
  await page.touchscreen.tap(point.x, point.y);
}

maybe('menu boots with a live WebGL2 renderer and clean console', async () => {
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
  });
  const { page, errors } = await openPage(context);
  assert.equal(await page.title(), 'GO/VOID — 3D Go');
  const info = await page.evaluate(() => ({
    screen: window.__goVoid.state.screen,
    gl: window.__goVoid.renderer.gl instanceof WebGL2RenderingContext,
    loadingGone: document.getElementById('loading-screen').classList.contains('gone'),
    startEnabled: !document.getElementById('start-btn').disabled,
    manifest: document.querySelector('link[rel=manifest]')?.getAttribute('href'),
  }));
  assert.equal(info.screen, 'menu');
  assert.equal(info.gl, true);
  assert.equal(info.loadingGone, true);
  assert.equal(info.startEnabled, true);
  assert.equal(info.manifest, '/manifest.webmanifest');
  assert.deepEqual(errors, []);
  await context.close();
});

maybe('pass-and-play: stones, passes, scoring, result, rematch and menu', async () => {
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
  });
  const { page, errors } = await openPage(context);
  await page.locator('#start-btn').click();
  await page.waitForFunction(() => window.__goVoid.state.screen === 'game');

  await tapIntersection(page, 40);
  await page.waitForFunction(() => window.__goVoid.state.game.moveNumber === 1);
  await tapIntersection(page, 30);
  await page.waitForFunction(() => window.__goVoid.state.game.moveNumber === 2);

  await page.locator('#btn-pass').click();
  await page.locator('#btn-pass').click();
  await page.waitForFunction(() => window.__goVoid.state.game.phase === 'scoring');
  assert.equal(await page.locator('#score-preview').isVisible(), true);
  assert.equal(await page.locator('#btn-pass').innerText(), 'SCORE');

  await page.locator('#btn-pass').click();
  await page.waitForFunction(() => window.__goVoid.state.finished === true);
  await page.locator('#modal-root').waitFor({ state: 'visible' });
  await page.waitForFunction(
    () => (document.querySelector('.modal #modal-title')?.textContent || '').length > 0,
  );
  assert.match(await page.locator('.modal #modal-title').textContent(), /WINS/);

  await page.locator('#result-rematch').click();
  await page.waitForFunction(
    () => window.__goVoid.state.screen === 'game' && window.__goVoid.state.game.moveNumber === 0,
  );
  assert.deepEqual(await page.evaluate(() => ({ done: window.__goVoid.state.finished })), { done: false });

  await page.locator('#btn-back-menu').click();
  await page.locator('#confirm-ok').waitFor({ state: 'visible' });
  await page.locator('#confirm-ok').click();
  await page.waitForFunction(() => window.__goVoid.state.screen === 'menu');
  assert.deepEqual(errors, []);
  await context.close();
});

maybe('settings persist and reduced motion applies to the document', async () => {
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
  });
  const { page, errors } = await openPage(context);
  await page.locator('#btn-settings').click();
  await page.locator('#modal-root').waitFor({ state: 'visible' });
  await page.locator('[data-quality="low"]').click();
  await page.locator('[data-motion="reduced"]').click();
  await page.locator('[data-sound="off"]').click();
  await page.locator('[data-haptics="off"]').click();
  await page.locator('#settings-done').click();
  await page.waitForFunction(() => document.getElementById('modal-root').classList.contains('hidden'));

  const stored = await page.evaluate(() => JSON.parse(localStorage.getItem('go-void:settings:v2')));
  assert.deepEqual(stored, {
    quality: 'low',
    motion: 'reduced',
    sound: 'off',
    haptics: 'off',
    size: 9,
    mode: 'local',
    difficulty: 'medium',
    color: '1',
  });

  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForFunction(() => window.__goVoid?.state?.booted, null, { timeout: 20_000 });
  assert.equal(
    await page.evaluate(() => document.documentElement.classList.contains('reduced-motion')),
    true,
  );
  assert.equal(await page.evaluate(() => window.__goVoid.settings.quality), 'low');
  assert.deepEqual(errors, []);
  await context.close();
});

maybe('VS machine replies and undo rewinds both stones', async () => {
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
  });
  const { page, errors } = await openPage(context);
  await page.locator('[data-mode="ai"]').click();
  await page.locator('[data-color="1"]').click();
  await page.locator('#start-btn').click();
  await page.waitForFunction(() => window.__goVoid.state.screen === 'game');
  assert.equal(await page.evaluate(() => window.__goVoid.state.humanColor), 1);

  await tapIntersection(page, 40);
  await page.waitForFunction(
    () => window.__goVoid.state.game.moveNumber === 2 && !window.__goVoid.state.thinking,
    null,
    { timeout: 15_000 },
  );
  assert.equal(await page.evaluate(() => window.__goVoid.state.game.turn), 1);

  await page.locator('#btn-undo').click();
  await page.waitForFunction(
    () =>
      window.__goVoid.state.game.moveNumber === 0 &&
      window.__goVoid.state.game.turn === window.__goVoid.state.humanColor,
  );
  assert.deepEqual(errors, []);
  await context.close();
});

maybe('P2P relay match syncs moves, resignation and rematch', async () => {
  const options = {
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
  };
  const ctxA = await browser.newContext(options);
  const ctxB = await browser.newContext(options);
  const a = await openPage(ctxA, '?nosw=1&relay=1');
  const b = await openPage(ctxB, '?nosw=1&relay=1');
  for (const { page } of [a, b]) {
    await page.locator('[data-mode="online"]').click();
  }
  await Promise.all([a.page.locator('#start-btn').click(), b.page.locator('#start-btn').click()]);
  await Promise.all([
    a.page.waitForFunction(
      () => window.__goVoid.state.screen === 'game' && window.__goVoid.state.netReady,
      null,
      { timeout: 20_000 },
    ),
    b.page.waitForFunction(
      () => window.__goVoid.state.screen === 'game' && window.__goVoid.state.netReady,
      null,
      { timeout: 20_000 },
    ),
  ]);

  const colorA = await a.page.evaluate(() => window.__goVoid.state.humanColor);
  const colorB = await b.page.evaluate(() => window.__goVoid.state.humanColor);
  assert.notEqual(colorA, colorB);
  assert.equal(await a.page.evaluate(() => window.__goVoid.state.netMode), 'relay');
  const [black, white] = colorA === 1 ? [a, b] : [b, a];

  await tapIntersection(black.page, 40);
  await white.page.waitForFunction(() => window.__goVoid.state.game.moveNumber === 1, null, {
    timeout: 8_000,
  });
  await tapIntersection(white.page, 30);
  await black.page.waitForFunction(() => window.__goVoid.state.game.moveNumber === 2, null, {
    timeout: 8_000,
  });

  await white.page.locator('#btn-resign').click();
  await white.page.locator('#confirm-ok').click();
  await Promise.all([
    black.page.waitForFunction(() => window.__goVoid.state.finished, null, { timeout: 8_000 }),
    white.page.waitForFunction(() => window.__goVoid.state.finished, null, { timeout: 8_000 }),
  ]);
  await black.page.waitForFunction(
    () => (document.querySelector('.modal #modal-title')?.textContent || '').length > 0,
  );
  await white.page.waitForFunction(
    () => (document.querySelector('.modal #modal-title')?.textContent || '').length > 0,
  );
  assert.match(await black.page.locator('.modal #modal-title').textContent(), /YOU WIN/);
  assert.match(await white.page.locator('.modal #modal-title').textContent(), /RIVAL WINS/);

  await black.page.locator('#result-rematch').click();
  await white.page.waitForFunction(
    () => document.getElementById('result-rematch')?.textContent === 'ACCEPT REMATCH',
    null,
    { timeout: 8_000 },
  );
  await white.page.locator('#result-rematch').click();
  await Promise.all([
    black.page.waitForFunction(
      () => window.__goVoid.state.game?.moveNumber === 0 && !window.__goVoid.state.finished,
      null,
      { timeout: 8_000 },
    ),
    white.page.waitForFunction(
      () => window.__goVoid.state.game?.moveNumber === 0 && !window.__goVoid.state.finished,
      null,
      { timeout: 8_000 },
    ),
  ]);
  assert.deepEqual(a.errors.slice(0, 1), []);
  assert.deepEqual(b.errors.slice(0, 1), []);
  await ctxA.close();
  await ctxB.close();
});

maybe('online scoring waits for both players and agrees on dead stones', async () => {
  const options = {
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
  };
  const ctxA = await browser.newContext(options);
  const ctxB = await browser.newContext(options);
  const a = await openPage(ctxA, '?nosw=1&relay=1');
  const b = await openPage(ctxB, '?nosw=1&relay=1');
  for (const { page } of [a, b]) await page.locator('[data-mode="online"]').click();
  await Promise.all([a.page.locator('#start-btn').click(), b.page.locator('#start-btn').click()]);
  await Promise.all(
    [a, b].map(({ page }) =>
      page.waitForFunction(
        () => window.__goVoid.state.screen === 'game' && window.__goVoid.state.netReady,
        null,
        { timeout: 20_000 },
      ),
    ),
  );

  const colorA = await a.page.evaluate(() => window.__goVoid.state.humanColor);
  const [black, white] = colorA === 1 ? [a, b] : [b, a];
  await tapIntersection(black.page, 40);
  await white.page.waitForFunction(() => window.__goVoid.state.game.moveNumber === 1, null, {
    timeout: 8_000,
  });
  await tapIntersection(white.page, 30);
  await black.page.waitForFunction(() => window.__goVoid.state.game.moveNumber === 2, null, {
    timeout: 8_000,
  });

  await black.page.locator('#btn-pass').click();
  await white.page.waitForFunction(() => window.__goVoid.state.game.passes === 1, null, {
    timeout: 8_000,
  });
  await white.page.locator('#btn-pass').click();
  await Promise.all(
    [a, b].map(({ page }) =>
      page.waitForFunction(() => window.__goVoid.state.game.phase === 'scoring', null, {
        timeout: 8_000,
      }),
    ),
  );
  await new Promise((resolve) => setTimeout(resolve, 1_600));
  assert.equal(await black.page.evaluate(() => window.__goVoid.state.finished), false);
  assert.equal(await white.page.evaluate(() => window.__goVoid.state.finished), false);

  await tapIntersection(black.page, 40);
  await tapIntersection(white.page, 40);
  assert.equal(await black.page.evaluate(() => window.__goVoid.state.game.dead.size), 1);
  assert.equal(await white.page.evaluate(() => window.__goVoid.state.game.dead.size), 1);

  await black.page.locator('#btn-pass').click();
  await white.page.waitForFunction(
    () => window.__goVoid.state.remoteScore?.length === 1,
    null,
    { timeout: 8_000 },
  );
  assert.equal(await white.page.evaluate(() => window.__goVoid.state.finished), false);
  await white.page.locator('#btn-pass').click();
  await Promise.all(
    [a, b].map(({ page }) =>
      page.waitForFunction(() => window.__goVoid.state.finished === true, null, { timeout: 8_000 }),
    ),
  );

  const resultA = await a.page.evaluate(() => window.__goVoid.state.lastResult);
  const resultB = await b.page.evaluate(() => window.__goVoid.state.lastResult);
  assert.deepEqual(resultA.score, resultB.score);
  assert.equal(resultA.score.stonesBlack + resultA.score.stonesWhite, 1);
  await ctxA.close();
  await ctxB.close();
});

maybe('service worker serves the shell offline', async () => {
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
  });
  const { page } = await openPage(context, '');
  await page.evaluate(async () => {
    const reg = await navigator.serviceWorker.ready;
    if (!reg.active) throw new Error('service worker did not activate');
    await caches.open('go-void-v2').then((cache) => cache.add('/manifest.webmanifest'));
  });
  const cached = await page.evaluate(async () =>
    (await (await caches.open('go-void-v2')).keys()).map((request) => request.url),
  );
  assert.equal(cached.some((url) => new URL(url).pathname === '/js/main.js'), true);

  await context.setOffline(true);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.__goVoid?.state?.booted, null, { timeout: 20_000 });
  assert.equal(await page.evaluate(() => window.__goVoid.state.screen), 'menu');
  assert.equal(await page.locator('#start-btn').isEnabled(), true);
  await context.setOffline(false);
  await context.close();
});
