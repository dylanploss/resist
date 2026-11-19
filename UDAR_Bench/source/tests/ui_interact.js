// App file: APP if set, else source/build/udar.html (after `node build/build.js`), else the packaged UDAR_Bench.html. Browser: CHROME if set, else Playwright's own Chromium. Screenshots go to tests/shots.
const __p = require('path'), __fs = require('fs'), APP_URL = require('url').pathToFileURL(process.env.APP || [__p.join(__dirname, '..', 'build', 'udar.html'), __p.join(__dirname, '..', '..', 'UDAR_Bench.html')].find(f => __fs.existsSync(f))).href;
const { chromium } = require('playwright');
(async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHROME || undefined, headless: true, args: ['--no-sandbox'] });
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  const errs = [];
  page.on('console', m => { if (m.type() === 'error' || m.type() === 'warning') errs.push(m.type() + ': ' + m.text()); });
  page.on('pageerror', e => errs.push('PAGEERROR: ' + e.message + '\n' + (e.stack || '').split('\n').slice(0, 5).join('\n')));
  const report = (tag) => { console.log(tag, errs.length ? errs.splice(0) : 'ok'); };
  const waitUp = async (n) => page.waitForFunction(() => Array.from(document.querySelectorAll('.pill')).some(x => x.textContent === 'Up to date') && !document.body.innerText.includes('Running'), null, { timeout: 120000 }).catch(e => console.log('timeout ' + n));
  await page.goto(APP_URL); await page.waitForTimeout(400);
  // --- Tool tab edits
  await page.fill('.tbl tbody tr:nth-child(1) td:nth-child(2) input', '9');
  await page.selectOption('.tbl tbody tr:nth-child(2) td:nth-child(5) select', 'T');
  await page.waitForTimeout(300);
  report('tool edits');
  await page.selectOption('.side select:has(option:text("Triaxial: 2 spacings × 2 frequencies"))', { label: 'Triaxial: 2 spacings × 2 frequencies' });
  await page.waitForTimeout(400); report('triaxial preset');
  // --- Geology: choose five-layer preset
  await page.click('#tab-geo'); await page.waitForTimeout(300);
  await page.selectOption('.side select:has(option:text("Five layers with laminated shale"))', { label: 'Five layers with laminated shale' });
  await page.waitForTimeout(500); report('five layer preset');
  // --- Forward
  await page.click('#tab-fwd'); await waitUp('fwd'); await page.waitForTimeout(500); report('forward');
  console.log('fwd info', await page.evaluate(() => ({ charts: FwdView.charts.length, nch: App.fwd && App.fwd.nch, nSt: App.fwd && App.fwd.nSt })));
  // click on a chart to move cursor
  const box = await page.locator('.stackcharts svg[height="200"]').first().boundingBox();
  await page.mouse.move(box.x + box.width * 0.6, box.y + 60); await page.mouse.click(box.x + box.width * 0.6, box.y + 60); await page.waitForTimeout(300);
  console.log('cursorMd after click', await page.evaluate(() => App.S.cursorMd)); report('chart click');
  await page.screenshot({ path: __p.join(__dirname, 'shots', '20_fwd_tri.png') });
  // --- Inversion with 5 layers
  await page.click('#tab-inv'); await page.waitForTimeout(300);
  await page.selectOption('.side select:has(option:text("7"))', '5'); await page.waitForTimeout(500);
  await page.screenshot({ path: __p.join(__dirname, 'shots', '21_inv5_before.png') });
  await page.click('text=Run inversion'); await waitUp('inv5'); await page.waitForTimeout(600);
  const stats = await page.evaluate(() => { const r = App.inv.res, n = r.length; const c = r.map(x => x.chi2).sort((a, b) => a - b); return { n, med: c[Math.floor(n / 2)], max: c[n - 1], ms: App.inv.ms }; });
  console.log('inv5 stats', stats); report('inv 5 layers');
  await page.screenshot({ path: __p.join(__dirname, 'shots', '22_inv5.png') });
  // --- ZZ only inversion: expect under-determined note
  await page.click('button:has-text("ZZ only")'); await page.waitForTimeout(400);
  console.log('status after chan change:', await page.evaluate(() => App.invStatus()));
  await page.click('text=Run inversion'); await waitUp('zz-only'); await page.waitForTimeout(400);
  console.log('toast:', await page.evaluate(() => document.querySelector('.toast') && document.querySelector('.toast').textContent));
  report('zz only');
  // --- persistence
  await page.waitForTimeout(700);
  await page.reload(); await page.waitForTimeout(600);
  console.log('after reload: tab', await page.evaluate(() => App.S.tab), 'layers', await page.evaluate(() => App.S.geo1.layers.length), 'nLayers', await page.evaluate(() => App.S.inv.nLayers), 'channels', await page.evaluate(() => App.S.tool.channels.length));
  report('reload');
  await browser.close();
})();
