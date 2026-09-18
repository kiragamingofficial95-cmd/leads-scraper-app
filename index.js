import express from "express";
import axios from "axios";
import * as cheerio from "cheerio";
import Groq from "groq-sdk";
import puppeteer from "puppeteer";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const app = express();
app.use(express.json());
app.use(express.static(join(__dirname, "public")));

const GROQ_API_KEY = process.env.GROQ_API_KEY;
const groq = GROQ_API_KEY ? new Groq({ apiKey: GROQ_API_KEY }) : null;
const GOOGLE_MAPS_URL = "https://www.google.com/maps/search/";
const DDG_URL = "https://html.duckduckgo.com/html/";

app.get("/", (req, res) => {
  res.sendFile(join(__dirname, "public", "index.html"));
});

app.get("/api", (req, res) => {
  res.json({
    name: "Leads Scraper API",
    version: "1.0.0",
    endpoints: {
      scrape: "POST /api/scrape",
      filter: "POST /api/filter",
      enrich: "POST /api/enrich"
    }
  });
});

app.post("/api/scrape", async (req, res) => {
  const { query, location } = req.body;
  if (!query || !location) return res.status(400).json({ error: "query and location required" });

  let browser;
  try {
    browser = await puppeteer.launch({
      headless: "new",
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
        "--disable-gpu",
        "--single-process"
      ]
    });

    const page = await browser.newPage();
    await page.setUserAgent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36");
    await page.setViewport({ width: 1280, height: 720 });

    const search = encodeURIComponent(`${query} in ${location}`);
    await page.goto(`${GOOGLE_MAPS_URL}${search}`, { waitUntil: "networkidle2", timeout: 45000 });

    await new Promise(r => setTimeout(r, 4000));

    for (let i = 0; i < 6; i++) {
      await page.evaluate(() => {
        const feed = document.querySelector('[role="feed"]');
        if (feed) feed.scrollTop = feed.scrollHeight;
        window.scrollBy(0, window.innerHeight);
      });
      await new Promise(r => setTimeout(r, 1500));
    }

    const leads = await page.evaluate(() => {
      const results = [];
      const feed = document.querySelector('[role="feed"]');
      if (!feed) return results;

      const items = feed.querySelectorAll(':scope > div > div');
      items.forEach(item => {
        const nameEl = item.querySelector('.qBF1Pd, .fontHeadlineSmall, [class*="fontHeadlineSmall"]');
        if (!nameEl) return;

        const name = nameEl.innerText.trim();
        if (!name) return;

        const allText = item.innerText || "";
        const lines = allText.split('\n').map(l => l.trim()).filter(Boolean);

        let rating = "", reviews = "", category = "", address = "", phone = "", url = "";

        const ratingMatch = allText.match(/(\d+\.?\d*)\s*stars?/i) || allText.match(/(\d+\.?\d*)\s*\(/);
        if (ratingMatch) rating = ratingMatch[1];

        const reviewsMatch = allText.match(/\((\d[\d,]*)\)/);
        if (reviewsMatch) reviews = reviewsMatch[1].replace(/,/g, "");

        const linkEl = item.querySelector('a[href*="maps"]');
        if (linkEl) url = linkEl.href;

        const phoneMatch = allText.match(/(\+?\d[\d\s\-()]{7,})/);
        if (phoneMatch) phone = phoneMatch[1].trim();

        for (const line of lines) {
          if (!address && (line.includes("St") || line.includes("Rd") || line.includes("Ave") || line.includes("Dr") || line.includes("Blvd") || line.includes("Way") || line.includes("Ln") || /\d+.*(?:street|road|avenue|drive|boulevard|lane)/i.test(line))) {
            address = line;
          }
        }

        if (address && lines.indexOf(address) > 0) {
          const catLine = lines[lines.indexOf(address) - 1];
          if (catLine && catLine !== name && !catLine.match(/^\d/)) category = catLine;
        }

        results.push({ name, rating, reviews, category, address, phone, url });
      });

      return results;
    });

    await browser.close();
    return res.status(200).json({ leads, query, location });
  } catch (error) {
    if (browser) await browser.close().catch(() => {});
    return res.status(500).json({ error: error.message });
  }
});

app.post("/api/filter", async (req, res) => {
  const lead = req.body;
  if (!lead || !lead.name) return res.status(400).json({ error: "Lead with name required" });
  if (!groq) return res.status(500).json({ error: "GROQ_API_KEY not configured" });

  try {
    const prompt = `Analyze this B2B lead for software development services qualification:

Name: ${lead.name || "N/A"}
Address: ${lead.address || "N/A"}
Phone: ${lead.phone || "N/A"}
Rating: ${lead.rating || "N/A"}
Reviews: ${lead.reviews || "N/A"}
Category: ${lead.category || "N/A"}

Return ONLY valid JSON:
{
  "qualified": true/false,
  "score": 1-10,
  "reason": "Brief explanation max 30 words",
  "industry": "Detected industry",
  "potentialNeed": "What software service they might need"
}`;

    const completion = await groq.chat.completions.create({
      messages: [{ role: "user", content: prompt }],
      model: "openai/gpt-oss-20b",
      temperature: 0.3,
      max_tokens: 500
    });

    const content = completion.choices[0].message.content;
    let decision;
    try {
      const jsonMatch = content.match(/\{[\s\S]*\}/);
      decision = jsonMatch ? JSON.parse(jsonMatch[0]) : { qualified: false, reason: "Could not parse" };
    } catch {
      decision = { qualified: false, score: 0, reason: "Invalid response" };
    }

    return res.status(200).json({ lead, ...decision });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
});

app.post("/api/enrich", async (req, res) => {
  const lead = req.body;
  if (!lead || !lead.name) return res.status(400).json({ error: "Lead with name required" });

  const enrichment = { emails: [], social: {}, website: "" };

  try {
    const searchQuery = `"${lead.name}" ${lead.address || ""} email contact`;
    const searchResp = await axios.get(`${DDG_URL}?q=${encodeURIComponent(searchQuery)}&kl=us-en`, { timeout: 15000 });
    const $ = cheerio.load(searchResp.data);

    const links = [];
    $(".result__url").each((_, el) => {
      const href = $(el).attr("href");
      if (href && !href.includes("duckduckgo")) links.push(href);
    });

    for (const url of [...new Set(links)].slice(0, 5)) {
      try {
        const pageResp = await axios.get(url, { timeout: 8000, maxRedirects: 5, headers: { "User-Agent": "Mozilla/5.0" } });
        const text = typeof pageResp.data === "string" ? pageResp.data : "";

        const emails = text.match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g) || [];
        enrichment.emails.push(...emails);

        const twitter = text.match(/twitter\.com\/([a-zA-Z0-9_]+)/i);
        if (twitter) enrichment.social.twitter = twitter[1];

        const linkedin = text.match(/linkedin\.com\/(in|company)\/([a-zA-Z0-9-]+)/i);
        if (linkedin) enrichment.social.linkedin = linkedin[2];

        const instagram = text.match(/instagram\.com\/([a-zA-Z0-9_.]+)/i);
        if (instagram) enrichment.social.instagram = instagram[1];

        const facebook = text.match(/facebook\.com\/([a-zA-Z0-9.]+)/i);
        if (facebook) enrichment.social.facebook = facebook[1];

        if (!enrichment.website) {
          const web = text.match(/https?:\/\/(www\.)?[a-zA-Z0-9-]+\.[a-z]{2,}/);
          if (web) enrichment.website = web[0];
        }
      } catch { continue; }
    }

    enrichment.emails = [...new Set(enrichment.emails)].slice(0, 5);
    enrichment.sourceUrl = lead.url || "";

    return res.status(200).json({ lead, enrichment });
  } catch (error) {
    return res.status(500).json({ error: error.message, enrichment });
  }
});

export default app;