// Mobile-viewport verification for the OCR text overflow + Merge Add-more
// fixes. Run on the Pi:  node verify-mobile.js
const puppeteer = require("puppeteer-core");
const path = require("path");
const fs = require("fs");

const URL = "http://127.0.0.1:90";
const SAMPLE = "/tmp/sample.pdf";
const OUT = "/tmp/shots-mobile";
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
  const p = path.join(OUT, name);
  await page.screenshot({ path: p, fullPage: false });
  console.log("→", p);
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

  // Mobile home
  await page.goto(URL, { waitUntil: "networkidle2" });
  await wait(300);
  await shot(page, "01-home.png");

  // OCR — upload a doc with text (will trigger OCR-skipped notice + show real text)
  await clickByText(page, "OCR");
  await wait(300);
  const ocrInput = await page.$("input[type=file]");
  await ocrInput.uploadFile(SAMPLE);
  await page.waitForSelector('select', { timeout: 15000 });
  await wait(300);
  await shot(page, "02-ocr-panel.png");

  // Run OCR; for the sample.pdf with text layer, this exercises the preview pane
  await clickByText(page, "Run OCR");
  // wait for either preview to appear or "Working" to clear (max ~60s)
  await page.waitForFunction(
    () => /Ready|Heads up/.test(document.body.innerText),
    { timeout: 60000 }
  );
  await wait(800);
  await shot(page, "03-ocr-result.png");

  // Measure horizontal overflow
  const overflow = await page.evaluate(() => {
    const doc = document.documentElement;
    return {
      scrollWidth: doc.scrollWidth,
      clientWidth: doc.clientWidth,
      overflows: doc.scrollWidth > doc.clientWidth,
    };
  });
  console.log("OCR result horizontal overflow check:", overflow);

  // Merge — verify "Add more" button uploads a second file
  await clickByText(page, "Back");
  await wait(200);
  await clickByText(page, "Merge");
  await wait(300);
  let mergeInput = await page.$("input[type=file]");
  await mergeInput.uploadFile(SAMPLE);
  await page.waitForSelector('button[aria-label="Drag to reorder"]', { timeout: 15000 });
  const initialCount = await page.$$eval('button[aria-label="Drag to reorder"]', (els) => els.length);
  console.log("After initial upload, items:", initialCount);
  await shot(page, "04-merge-after-first.png");

  // Click "Add more" — wait until file inputs include the second-zone one,
  // then upload via the LAST input (the one belonging to the Add-more zone).
  await clickByText(page, "Add more");
  await wait(200);
  const inputs = await page.$$('input[type=file]');
  const lastInput = inputs[inputs.length - 1];
  await lastInput.uploadFile(SAMPLE);
  // Wait until the row count grows
  await page.waitForFunction(
    () => document.querySelectorAll('button[aria-label="Drag to reorder"]').length >= 2,
    { timeout: 10000 }
  );
  const afterAddMore = await page.$$eval('button[aria-label="Drag to reorder"]', (els) => els.length);
  console.log("After Add more, items:", afterAddMore);
  await shot(page, "05-merge-after-add-more.png");

  if (afterAddMore < 2) {
    throw new Error("Add more did not add a second file");
  }
  console.log("Add more is working ✓");

  await browser.close();
  console.log("done");
})().catch((e) => {
  console.error("VERIFY FAILED:", e);
  process.exit(1);
});
