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
  const waitUp = async (n) => page.waitForFunction(() => Array.from(document.querySelectorAll('.pill')).some(x => x.textContent === 'Up to date') && !document.body.innerText.includes('Running'), null, { timeout: 60000 }).catch(e => console.log('timeout ' + n));
  await page.goto(APP_URL); await page.waitForTimeout(400);
  await page.click('#tab-geo'); await page.waitForTimeout(300);
  await page.selectOption('.side select:has(option:text("Five layers with laminated shale"))', { label: 'Five layers with laminated shale' });
  await page.click('#tab-inv'); await page.waitForTimeout(300);
  await page.selectOption('.side select:has(option:text("7"))', '5'); await page.waitForTimeout(500);
  await page.click('button:has-text("ZZ only")'); await page.waitForTimeout(400);
  console.log('underNote hidden?', await page.evaluate(() => InvView.underNote.hidden), '| info:', await page.evaluate(() => InvView.info.textContent));
  await page.click('button:has-text("All")'); await page.waitForTimeout(300);
  console.log('underNote hidden?', await page.evaluate(() => InvView.underNote.hidden), '| info:', await page.evaluate(() => InvView.info.textContent));
  await page.click('text=Run inversion'); await page.waitForTimeout(1500);
  console.log('during run info:', await page.evaluate(() => InvView.info.textContent));
  await waitUp('inv5');
  console.log('inv5', await page.evaluate(() => { const r = App.inv.res, n = r.length, c = r.map(x => x.chi2).sort((a, b) => a - b); return { n, med: +c[Math.floor(n / 2)].toFixed(3), max: +c[n - 1].toFixed(3), ms: Math.round(App.inv.ms) }; }));
  report('inv 5');
  await page.waitForTimeout(700);
  await page.reload(); await page.waitForTimeout(1500);
  console.log('after reload: tab', await page.evaluate(() => App.S.tab), 'fwdStatus', await page.evaluate(() => App.fwdStatus()));
  report('reload');
  // open each tab after reload
  for (const t of ['tool', 'geo', 'fwd', 'inv']) { await page.click('#tab-' + t); await page.waitForTimeout(500); }
  report('tabs after reload');
  await browser.close();
})();
