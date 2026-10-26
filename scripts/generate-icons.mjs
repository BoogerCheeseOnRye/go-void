/* Regenerate PWA icons from public/icons/icon.svg.
   Usage: npm run icons  (requires the Playwright Chromium download). */

import { chromium } from 'playwright';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const svg = readFileSync(resolve(root, 'public/icons/icon.svg'), 'utf8');
const out = (name) => resolve(root, 'public/icons', name);

const browser = await chromium.launch();
for (const size of [192, 512]) {
  const page = await browser.newPage({ viewport: { width: size, height: size }, deviceScaleFactor: 1 });
  await page.setContent(
    `<!doctype html><style>html,body{margin:0;width:100%;height:100%;overflow:hidden;background:transparent}svg{display:block;width:100%;height:100%}</style>${svg}`,
  );
  await page.screenshot({ path: out(`icon-${size}.png`), omitBackground: true });
  await page.close();
}

const maskable = await browser.newPage({ viewport: { width: 512, height: 512 }, deviceScaleFactor: 1 });
await maskable.setContent(`<!doctype html><style>
html,body{margin:0;width:100%;height:100%;overflow:hidden;background:#05040a}
.backdrop{position:absolute;inset:0;background:radial-gradient(circle at 34% 26%,#211a45 0,#0b0818 48%,#030207 100%)}
.wrap{position:absolute;inset:0;display:grid;place-items:center}
.wrap svg{display:block;width:72%;height:72%;filter:drop-shadow(0 0 24px rgba(106,246,255,.12))}
</style><div class="backdrop"></div><div class="wrap">${svg.replace('<svg ', '<svg style="border-radius:0" ')}</div>`);
await maskable.screenshot({ path: out('icon-maskable-512.png') });
await maskable.close();
await browser.close();
console.log('icons written to public/icons');
