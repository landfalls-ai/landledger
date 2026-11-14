const { chromium } = require(process.argv[2]);
const P = 'file:///Users/pickjonathan/WorkSpace/landledger/ui/prototype.html';
const out = process.argv[3];
(async () => {
  const b = await chromium.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true });
  const shots = [['overview',390,2,'overview-390',false],['request',390,2,'request-390',false],['request',390,2,'decide-390',false,true],['explore',390,2,'explore-390',false],['close',390,2,'close-390',false]];
  for (const [r,w,dpr,name,full,bottom] of shots) {
    const c = await b.newContext({ viewport: { width: w, height: w < 500 ? 844 : 900 }, deviceScaleFactor: dpr, colorScheme: 'dark', isMobile: w < 500, hasTouch: w < 500 });
    const p = await c.newPage(); await p.goto(P + '#' + r); await p.waitForTimeout(800);
    if (bottom) { await p.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight)); await p.waitForTimeout(300); }
    const sw = await p.evaluate(() => document.documentElement.scrollWidth);
    await p.screenshot({ path: `${out}/${name}.png`, fullPage: full });
    console.log(name, 'scrollWidth', sw); await c.close();
  }
  await b.close();
})();
