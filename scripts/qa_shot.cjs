// usage: node scripts/qa_shot.cjs out.png "eye" "target" [boxes=1] [w] [h]
const { chromium } = require('playwright');
(async () => {
  const [out, eye, t, boxes = '1', w = '1280', h = '720'] = process.argv.slice(2);
  const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
  const page = await browser.newPage({ viewport: { width: +w, height: +h } });
  page.on('console', m => { if (m.type() === 'error') console.log('console:', m.text()); });
  page.on('pageerror', e => console.log('pageerror:', e.message));
  await page.goto(`http://localhost:5173/qa.html?eye=${eye}&t=${t}&boxes=${boxes}&splat=${process.env.SPLAT||'/data/qa.splat'}&wait=${process.env.WAIT||8000}`);
  await page.waitForFunction(() => window.__ready === true, null, { timeout: 280000 });
  await page.screenshot({ path: out });
  await browser.close();
})();
