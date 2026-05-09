// Quick screenshot harness for PDFflix README. Run on the Pi:
//   node shotter.js
// Requires: puppeteer-core (uses /usr/bin/chromium), service running on :90,
// sample PDF at /tmp/sample.pdf.

const puppeteer = require("puppeteer-core");
const fs = require("fs");
const path = require("path");

const URL = "http://127.0.0.1:90";
const SAMPLE = "/tmp/sample.pdf";
const OUT = "/tmp/shots";

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
  fs.mkdirSync(OUT, { recursive: true });
  const p = path.join(OUT, name);
  await page.screenshot({ path: p, fullPage: false });
  console.log("→", p);
}

(async () => {
  const browser = await puppeteer.launch({
    executablePath: "/usr/bin/chromium",
    headless: "new",
    args: [
      "--no-sandbox",
      "--disable-gpu",
      "--hide-scrollbars",
      "--disable-dev-shm-usage",
    ],
    defaultViewport: { width: 1280, height: 900, deviceScaleFactor: 2 },
  });
  const page = await browser.newPage();
  await page.setDefaultTimeout(15000);

  // ── Home ──
  await page.goto(URL, { waitUntil: "networkidle2" });
  await wait(400);
  await shot(page, "01-home.png");

  // ── Split: empty ──
  await clickByText(page, "Split");
  await wait(400);
  await shot(page, "02-split-empty.png");

  // upload sample
  const splitInput = await page.$("input[type=file]");
  await splitInput.uploadFile(SAMPLE);
  await page.waitForSelector(".grid img", { timeout: 15000 });
  await wait(800);
  await shot(page, "03-split-loaded.png");

  // switch to "Pick pages" tab + select a few
  await clickByText(page, "Pick pages");
  await wait(200);
  // click pages 1, 3, 5 (the parent <button> that wraps each thumb)
  await page.evaluate(() => {
    const btns = [...document.querySelectorAll('button[aria-label^="Toggle page"]')];
    [1, 3, 5].forEach((n) => btns[n - 1] && btns[n - 1].click());
  });
  await wait(400);
  await shot(page, "04-split-pick.png");

  // back home
  await clickByText(page, "Back");
  await wait(300);

  // ── Reorder ──
  await clickByText(page, "Reorder");
  await wait(300);
  const reorderInput = await page.$("input[type=file]");
  await reorderInput.uploadFile(SAMPLE);
  await page.waitForSelector(".grid img", { timeout: 15000 });
  await wait(800);
  await shot(page, "05-reorder.png");

  await clickByText(page, "Back");
  await wait(300);

  // ── OCR ──
  await clickByText(page, "OCR");
  await wait(300);
  const ocrInput = await page.$("input[type=file]");
  await ocrInput.uploadFile(SAMPLE);
  await page.waitForSelector('button:has(div), select', { timeout: 15000 });
  await wait(800);
  await shot(page, "06-ocr.png");

  await clickByText(page, "Back");
  await wait(300);

  // ── Merge ──
  await clickByText(page, "Merge");
  await wait(300);
  const mergeInput = await page.$("input[type=file]");
  // upload sample twice (puppeteer accepts multiple paths)
  await mergeInput.uploadFile(SAMPLE, SAMPLE);
  await wait(800);
  await shot(page, "07-merge.png");

  // ── Page viewer (lightbox) ──
  await clickByText(page, "Back");
  await wait(200);
  await clickByText(page, "Split");
  await wait(300);
  const splitInput2 = await page.$("input[type=file]");
  await splitInput2.uploadFile(SAMPLE);
  await page.waitForSelector(".grid img", { timeout: 15000 });
  await wait(700);
  // hover the first thumb tile to reveal the eye button, then click it
  await page.evaluate(() => {
    const btn = document.querySelector('button[aria-label="View page 3"]');
    if (btn) btn.click();
  });
  await wait(900);
  await shot(page, "08-page-viewer.png");

  await browser.close();
  console.log("done");
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
