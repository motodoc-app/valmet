const { chromium } = require('playwright');
(async () => {
  const [out, script = '', wait = '20000'] = process.argv.slice(2);
  const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
  const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
  page.on('console', m => { if (['error','warning'].includes(m.type())) console.log('console', m.type(), m.text().slice(0, 300)); });
  page.on('pageerror', e => console.log('pageerror:', e.message));
  await page.goto('http://localhost:5173/?splat=/data/qa.splat' + (process.env.Q || ''));
  await page.waitForTimeout(+wait);
  if (script) { await page.evaluate(script); await page.waitForTimeout(+(process.env.AFTER || 8000)); }
  await page.screenshot({ path: out, timeout: 120000 });
  await browser.close();
})();
