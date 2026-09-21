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

  // Support both single string and array of queries
  const queries = Array.isArray(query) ? query.filter(q => q && q.trim()) : [query];
  if (queries.length === 0) {
    return res.status(400).json({ error: "At least one query required" });
  }

  let browser;
  try {
    browser = await puppeteer.launch({
      headless: "new",
      args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"]
    });

    const page = await browser.newPage();
    await page.setUserAgent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36");

    async function extractLeads(searchQuery) {
      const search = encodeURIComponent(`${searchQuery} in ${location}`);
      await page.goto(`${GOOGLE_MAPS_URL}${search}`, { waitUntil: "networkidle2", timeout: 30000 });
      await new Promise(r => setTimeout(r, 3000));

      for (let i = 0; i < 5; i++) {
        await page.evaluate(() => window.scrollBy(0, window.innerHeight));
        await new Promise(r => setTimeout(r, 1000));
      }

      return await page.evaluate((keyword) => {
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
              url: linkEl ? linkEl.href : "",
              website: "",
              searchKeyword: keyword
            });
          }
        });

        return results;
      }, searchQuery);
    }

    // Scrape all queries and deduplicate by name+address
    const allLeads = [];
    const seen = new Set();

    for (const q of queries) {
      try {
        const leads = await extractLeads(q.trim());
        for (const lead of leads) {
          const key = `${lead.name}|||${lead.address}`;
          if (!seen.has(key)) {
            seen.add(key);
            allLeads.push(lead);
          }
        }
      } catch {
        continue;
      }
    }

    await browser.close();
    return res.status(200).json({ leads: allLeads, queries, location });
  } catch (error) {
    if (browser) await browser.close();
    return res.status(500).json({ error: error.message });
  }
}
