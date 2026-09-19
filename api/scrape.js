import puppeteer from "puppeteer";

const GOOGLE_MAPS_URL = "https://www.google.com/maps/search/";

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

  const { query, location } = req.body;

  if (!query || !location) {
    return res.status(400).json({ error: "query and location are required" });
  }

  let browser;
  try {
    browser = await puppeteer.launch({
      headless: "new",
      args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"]
    });

    const page = await browser.newPage();
    await page.setUserAgent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36");

    const search = encodeURIComponent(`${query} in ${location}`);
    await page.goto(`${GOOGLE_MAPS_URL}${search}`, { waitUntil: "networkidle2", timeout: 30000 });

    await page.evaluate(() => new Promise(r => setTimeout(r, 3000)));

    for (let i = 0; i < 5; i++) {
      await page.evaluate(() => window.scrollBy(0, window.innerHeight));
      await new Promise(r => setTimeout(r, 1000));
    }

    const leads = await page.evaluate(() => {
      const results = [];
      const items = document.querySelectorAll('[role="feed"] > div > div');

      items.forEach(item => {
        const nameEl = item.querySelector(".fontHeadlineSmall, .qBF1Pd");
        const ratingEl = item.querySelector(".MW4etd");
        const reviewsEl = item.querySelector(".UY7F9");
        const categoryEl = item.querySelector(".W4Efsd span:first-child");
        const addressEl = item.querySelector(".W4Efsd span:nth-child(2)");
        const phoneEl = item.querySelector(".UsdlK");
        const linkEl = item.querySelector("a.hfpxzc");

        if (nameEl) {
          results.push({
            name: nameEl.innerText.trim(),
            rating: ratingEl ? ratingEl.innerText.trim() : "",
            reviews: reviewsEl ? reviewsEl.innerText.trim().replace(/[()]/g, "") : "",
            category: categoryEl ? categoryEl.innerText.trim() : "",
            address: addressEl ? addressEl.innerText.trim() : "",
            phone: phoneEl ? phoneEl.innerText.trim() : "",
            url: linkEl ? linkEl.href : ""
          });
        }
      });

      return results;
    });

    await browser.close();
    return res.status(200).json({ leads });
  } catch (error) {
    if (browser) await browser.close();
    return res.status(500).json({ error: error.message });
  }
}