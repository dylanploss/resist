// App file: APP if set, else source/build/udar.html (after `node build/build.js`), else the packaged UDAR_Bench.html. Browser: CHROME if set, else Playwright's own Chromium. Screenshots go to tests/shots.
const __p = require('path'), __fs = require('fs'), APP_URL = require('url').pathToFileURL(process.env.APP || [__p.join(__dirname, '..', 'build', 'udar.html'), __p.join(__dirname, '..', '..', 'UDAR_Bench.html')].find(f => __fs.existsSync(f))).href;
const { chromium } = require('playwright');
(async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHROME || undefined, headless: true, args: ['--no-sandbox'] });
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: 'light' });
  const page = await ctx.newPage();
  const errs = [];
  page.on('console', m => { if (m.type() === 'error' || m.type() === 'warning') errs.push(m.type() + ': ' + m.text()); });
  page.on('pageerror', e => errs.push('PAGEERROR: ' + e.message + '\n' + (e.stack || '').split('\n').slice(0, 4).join('\n')));
  await page.goto(APP_URL);
  await page.waitForTimeout(400);
  // switch to 2D
  await page.click('.seg button:has-text("2D")'); await page.waitForTimeout(400);
  await page.click('#tab-geo'); await page.waitForTimeout(500);
  await page.screenshot({ path: __p.join(__dirname, 'shots', '10_geo2d.png') });
  console.log('2d geo errs', errs.splice(0));
  await page.click('#tab-fwd');
  await page.waitForFunction(() => document.body.innerText.includes('Up to date'), null, { timeout: 30000 }).catch(e => console.log('fwd2d did not finish'));
  await page.waitForTimeout(600);
  await page.screenshot({ path: __p.join(__dirname, 'shots', '11_fwd2d.png') });
  console.log('2d fwd errs', errs.splice(0));
  await page.click('#tab-inv'); await page.waitForTimeout(300);
  await page.click('text=Run inversion');
  await page.waitForFunction(() => Array.from(document.querySelectorAll('.pill')).some(x => x.textContent === 'Up to date') && !document.body.innerText.includes('Running'), null, { timeout: 120000 }).catch(e => console.log('inv2d did not finish'));
  await page.waitForTimeout(600);
  await page.screenshot({ path: __p.join(__dirname, 'shots', '12_inv2d.png') });
  console.log('2d inv errs', errs.splice(0));
  // about dialog + dark theme
  await page.click('button[aria-label="About this model"]'); await page.waitForTimeout(200);
  await page.screenshot({ path: __p.join(__dirname, 'shots', '13_about.png') });
  await page.keyboard.press('Escape');
  await page.click('button[aria-label^="Theme"]'); await page.click('button[aria-label^="Theme"]'); await page.waitForTimeout(500);
  await page.screenshot({ path: __p.join(__dirname, 'shots', '14_dark.png') });
  console.log('final errs', errs.splice(0));
  await browser.close();
})();
