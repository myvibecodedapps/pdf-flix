// Mobile-viewport screenshots of the OCR flow and the new home grid.
const puppeteer = require("puppeteer-core");
const fs = require("fs");
const path = require("path");

const URL = "http://127.0.0.1:90";
const SAMPLE = "/tmp/sample.pdf";
const OUT = "/tmp/shots-ocr";
fs.mkdirSync(OUT, { recursive: true });

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
async function clickByText(page, text) {
  await page.evaluate((t) => {
    const els = [...document.querySelectorAll("button, a, [role=button]")];
    const el = els.find((e) => e.textContent.trim() === t);
    if (!el) throw new Error(`No element with text "${t}"`);
    el.click();
  }, text);
}
async function shot(page, name) {
  await page.screenshot({ path: path.join(OUT, name), fullPage: false });
  console.log("→", path.join(OUT, name));
}

(async () => {
  const browser = await puppeteer.launch({
    executablePath: "/usr/bin/chromium",
    headless: "new",
    args: ["--no-sandbox", "--disable-gpu", "--hide-scrollbars", "--disable-dev-shm-usage"],
    defaultViewport: { width: 390, height: 844, isMobile: true, deviceScaleFactor: 2 },
  });
  const page = await browser.newPage();
  await page.setDefaultTimeout(15000);

  // Home — confirm the 5th tile centers
  await page.goto(URL, { waitUntil: "networkidle2" });
  await wait(400);
  await shot(page, "01-home-mobile.png");

  // OCR — empty
  await clickByText(page, "OCR");
  await wait(300);
  await shot(page, "02-ocr-empty.png");

  // OCR — uploaded, options panel
  const ocrInput = await page.$("input[type=file]");
  await ocrInput.uploadFile(SAMPLE);
  await page.waitForSelector('select', { timeout: 15000 });
  await wait(400);
  await shot(page, "03-ocr-panel.png");
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  await wait(200);
  await shot(page, "04-ocr-panel-bottom.png");

  // Run OCR and capture the result
  await page.evaluate(() => window.scrollTo(0, 0));
  await clickByText(page, "Run OCR");
  await page.waitForFunction(
    () => /Ready|Heads up|OCR couldn/.test(document.body.innerText),
    { timeout: 60000 }
  );
  await wait(800);
  await shot(page, "05-ocr-result-top.png");
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  await wait(200);
  await shot(page, "06-ocr-result-bottom.png");

  // Overflow check
  const o = await page.evaluate(() => ({
    sw: document.documentElement.scrollWidth,
    cw: document.documentElement.clientWidth,
  }));
  console.log("OCR result horizontal:", o, "overflows?", o.sw > o.cw);

  await browser.close();
})().catch((e) => { console.error(e); process.exit(1); });
