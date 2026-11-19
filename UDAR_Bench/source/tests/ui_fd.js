// Playwright test of the 2.5D forward mode: settings, estimate, run with progress, cancel, solver panel, overlay, inversion
// App file: APP if set, else source/build/udar.html (after `node build/build.js`), else the packaged UDAR_Bench.html. Browser: CHROME if set, else Playwright's own Chromium. Screenshots go to tests/shots.
const __p = require('path'), __fs = require('fs'), APP_URL = require('url').pathToFileURL(process.env.APP || [__p.join(__dirname, '..', 'build', 'udar.html'), __p.join(__dirname, '..', '..', 'UDAR_Bench.html')].find(f => __fs.existsSync(f))).href;
const { chromium } = require('playwright');
(async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHROME || undefined, headless: true, args: ['--no-sandbox'] });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const errs = [];
  page.on('console', m => { if (m.type() === 'error' || m.type() === 'warning') errs.push(m.type() + ': ' + m.text()); });
  page.on('pageerror', e => errs.push('PAGEERROR: ' + e.message + '\n' + (e.stack || '').split('\n').slice(0, 4).join('\n')));
  await page.goto(APP_URL);
  await page.evaluate(() => localStorage.clear()); await page.reload(); await page.waitForTimeout(400);
  // 2D mode, shorter log and lighter tool so the run fits in a test
  await page.click('button:has-text("2D")'); await page.waitForTimeout(300);
  await page.evaluate((q) => {
    const S = App.S; S.well.mdStart = +q.a; S.well.mdEnd = +q.b; S.well.mdStep = 2; S.fd.q = q.q;
    if (q.preset) { S.geo2 = clone(PRESETS_GEO2[q.preset]); }
    S.tool.channels = S.tool.channels.filter(c => c.L !== 8);   // drop the 100 kHz pair to keep the test short
    App.rebuild(); App.changed();
  }, { a: process.env.MDA || '200', b: process.env.MDB || '280', q: process.env.Q || 'draft', preset: process.env.PRESET || '' });
  await page.click('#tab-fwd'); await page.waitForTimeout(800);
  const side = await page.locator('.side:not([hidden])').innerText();
  console.log('--- side panel ---\n' + side.split('\n').filter(l => /solver|Solver|Accuracy|First pass|2.5D|stations every/i.test(l)).join('\n'));
  await page.screenshot({ path: __p.join(__dirname, 'shots', 'fd_01_before.png') });
  // cancel test
  await page.click('text=Run forward model'); await page.waitForTimeout(2500);
  console.log('progress text after 2.5 s:', await page.locator('.side:not([hidden]) .hint').first().innerText());
  await page.click('button:has-text("Cancel")'); await page.waitForTimeout(500);
  console.log('status after cancel:', await page.locator('.pill').first().innerText());
  // full run
  const t0 = Date.now();
  await page.click('text=Run forward model');
  let lastTxt = '';
  for (let k = 0; k < 600; k++) {
    await page.waitForTimeout(1000);
    const st = await page.locator('.pill').first().innerText();
    const tx = await page.locator('.side:not([hidden]) .hint').first().innerText();
    if (tx !== lastTxt && k % 10 === 0) { console.log('[' + k + ' s] ' + tx); lastTxt = tx; }
    if (st === 'Up to date') break;
  }
  console.log('2.5D run wall time', ((Date.now() - t0) / 1000).toFixed(1), 's; status', await page.locator('.pill').first().innerText());
  await page.waitForTimeout(800);
  await page.screenshot({ path: __p.join(__dirname, 'shots', 'fd_02_after.png') });
  const mainTxt = await page.locator('.main:not([hidden])').innerText();
  const i0 = mainTxt.indexOf('2.5D solver'); console.log('--- solver panel ---\n' + mainTxt.slice(i0, i0 + 1500));
  await page.evaluate(() => { const m = document.querySelector('.main:not([hidden])'); m.scrollTo(0, m.scrollHeight); }); await page.waitForTimeout(300);
  await page.screenshot({ path: __p.join(__dirname, 'shots', 'fd_03_panel.png') });
  console.log('errors so far:', errs.splice(0));
  // inversion on the 2.5D data
  await page.click('#tab-inv'); await page.waitForTimeout(500);
  await page.click('text=Run inversion');
  await page.waitForFunction(() => { const p = document.querySelectorAll('.pill'); return Array.from(p).some(x => x.textContent === 'Up to date') && !document.body.innerText.includes('Running'); }, null, { timeout: 300000 }).catch(e => console.log('inv did not finish: ' + e.message));
  await page.waitForTimeout(800);
  await page.screenshot({ path: __p.join(__dirname, 'shots', 'fd_04_inv.png') });
  console.log('errors at end:', errs.splice(0));
  await browser.close();
})();
