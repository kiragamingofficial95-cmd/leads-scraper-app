import chromium from "@sparticuz/chromium";
import puppeteer from "puppeteer-core";

export const maxDuration = 60;

const GOOGLE_MAPS_URL = "https://www.google.com/maps/search/";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") {
    return res.status(200).end();
  }

  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const { query, location, limit } = req.body || {};

  if (!query || !location) {
    return res.status(400).json({ error: "query and location are required" });
  }

  const maxLeads = Math.min(parseInt(limit) || 15, 20);

  let browser;
  try {
    browser = await puppeteer.launch({
      args: chromium.args,
      defaultViewport: chromium.defaultViewport,
      executablePath: await chromium.executablePath(),
      headless: chromium.headless,
    });

    const page = await browser.newPage();
    await page.setUserAgent(
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
    );

    const search = encodeURIComponent(`${query} in ${location}`);
    await page.goto(`${GOOGLE_MAPS_URL}${search}`, {
      waitUntil: "domcontentloaded",
      timeout: 25000,
    });

    await sleep(2500);

    for (let i = 0; i < 3; i++) {
      await page.evaluate(() => {
        const feed = document.querySelector('[role="feed"]');
        if (feed) feed.scrollTop = feed.scrollHeight;
      });
      await sleep(800);
    }

    const leads = await page.evaluate((max) => {
      const results = [];
      const seenNames = new Set();
      const feed = document.querySelector('[role="feed"]');
      if (!feed) return results;
      const items = feed.querySelectorAll(":scope > div > div");

      for (const item of items) {
        if (results.length >= max) break;
        const nameEl = item.querySelector(".fontHeadlineSmall, .qBF1Pd, .NrDZNb, .dbg0pd");
        if (!nameEl) continue;
        const name = nameEl.innerText.trim();
        if (!name || seenNames.has(name)) continue;
        seenNames.add(name);

        const allText = item.innerText || "";
        let rating = "", reviews = "", category = "", address = "", phone = "", url = "";

        const ratingEl = item.querySelector(".MW4etd");
        if (ratingEl) rating = ratingEl.innerText.trim();

        const reviewsEl = item.querySelector(".UY7F9");
        if (reviewsEl) reviews = reviewsEl.innerText.trim().replace(/[()]/g, "");

        const categoryEl = item.querySelector(".W4Efsd span:first-child, .DkEaL");
        if (categoryEl) category = categoryEl.innerText.trim();

        const addressEl = item.querySelector(".W4Efsd span:nth-child(2)");
        if (addressEl) address = addressEl.innerText.trim();

        const phoneEl = item.querySelector(".UsdlK");
        if (phoneEl) phone = phoneEl.innerText.trim();

        const linkEl = item.querySelector("a.hfpxzc, a[href*='maps']");
        if (linkEl) url = linkEl.href;

        results.push({ name, rating, reviews, category, address, phone, url });
      }

      return results;
    }, maxLeads);

    await browser.close();
    return res.status(200).json({ leads, query, location });
  } catch (error) {
    if (browser) await browser.close().catch(() => {});
    return res.status(500).json({ error: error.message || "Scrape failed" });
  }
}
