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
      const seenNames = new Set();
      const items = document.querySelectorAll('[role="feed"] > div > div');

      items.forEach(item => {
        const nameEl = item.querySelector(".fontHeadlineSmall, .qBF1Pd, .NrDZNb, .dbg0pd, [class*='fontHeadlineSmall']");
        if (!nameEl) return;
        const name = nameEl.innerText.trim();
        if (!name || seenNames.has(name)) return;
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

        if (!category && allText) {
          const lines = allText.split('\n').map(l => l.trim()).filter(Boolean);
          for (const line of lines) {
            if (!address && /\d+.*(?:street|road|avenue|drive|boulevard|lane|st|rd|ave|dr|blvd|way|ln)/i.test(line)) {
              address = line;
            }
          }
        }

        results.push({
          name,
          rating,
          reviews,
          category,
          address,
          phone,
          url
        });
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