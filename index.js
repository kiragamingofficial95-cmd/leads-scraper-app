import express from "express";
import axios from "axios";
import * as cheerio from "cheerio";
import Groq from "groq-sdk";
import puppeteer from "puppeteer";
import chromium from "@sparticuz/chromium";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const app = express();
app.use(express.json());
app.use(express.static(join(__dirname, "public")));

const GROQ_API_KEY = process.env.GROQ_API_KEY;
const groq = GROQ_API_KEY ? new Groq({ apiKey: GROQ_API_KEY }) : null;
console.log("Groq initialized:", !!groq, "Key present:", !!GROQ_API_KEY);
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
      headless: chromium.headless,
      args: chromium.args,
      defaultViewport: chromium.defaultViewport,
      executablePath: await chromium.executablePath(),
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
        let rating = "", reviews = "", category = "", address = "", phone = "", url = "", website = "";

        const ratingMatch = allText.match(/(\d+\.?\d*)\s*stars?/i) || allText.match(/(\d+\.?\d*)\s*\(/);
        if (ratingMatch) rating = ratingMatch[1];

        const reviewsMatch = allText.match(/\((\d[\d,]*)\)/);
        if (reviewsMatch) reviews = reviewsMatch[1].replace(/,/g, "");

        const linkEl = item.querySelector('a[href*="maps"]');
        if (linkEl) url = linkEl.href;

        const phoneMatch = allText.match(/(\+?\d[\d\s\-()]{7,})/);
        if (phoneMatch) phone = phoneMatch[1].trim();

        const webMatch = allText.match(/(?:https?:\/\/)?(?:www\.)?([a-zA-Z0-9-]+\.[a-z]{2,})/);
        if (webMatch && !webMatch[0].includes("google") && !webMatch[0].includes("gstatic")) {
          website = webMatch[0].startsWith("http") ? webMatch[0] : "https://" + webMatch[0];
        }

        for (const line of lines) {
          if (!address && (line.includes("St") || line.includes("Rd") || line.includes("Ave") || line.includes("Dr") || line.includes("Blvd") || line.includes("Way") || line.includes("Ln") || /\d+.*(?:street|road|avenue|drive|boulevard|lane)/i.test(line))) {
            address = line;
          }
        }

        if (address && lines.indexOf(address) > 0) {
          const catLine = lines[lines.indexOf(address) - 1];
          if (catLine && catLine !== name && !catLine.match(/^\d/)) category = catLine;
        }

        results.push({ name, rating, reviews, category, address, phone, url, website });
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
    const prompt = `You are a B2B sales qualification expert. A web development agency wants to pitch their services (website design, web apps, ecommerce, SEO) to local businesses.

Analyze this lead and determine if they are a GOOD PROSPECT to pitch web development services to.

Lead Info:
- Business Name: ${lead.name || "N/A"}
- Category/Industry: ${lead.category || "N/A"}
- Address: ${lead.address || "N/A"}
- Phone: ${lead.phone || "N/A"}
- Rating: ${lead.rating || "N/A"}
- Reviews: ${lead.reviews || "N/A"}
- Website: ${lead.website || "None found"}

Qualification Criteria:
- Does this business likely need a website or web app?
- Are they established enough to afford web dev services?
- Is their industry a good fit for web development?
- If they have no website or a poor one, they are HIGH priority.

Return ONLY valid JSON:
{
  "qualified": true/false,
  "score": 1-10,
  "reason": "Brief explanation max 30 words",
  "industry": "Detected industry",
  "potentialNeed": "Specific web dev service they need",
  "pitchAngle": "How to approach them for web dev pitch"
}`;

    const completion = await groq.chat.completions.create({
      messages: [{ role: "user", content: prompt }],
      model: "openai/gpt-oss-20b",
      temperature: 0.3,
      max_tokens: 600
    });

    const content = completion.choices[0].message.content;
    if (!content) {
      return res.status(200).json({ lead, qualified: false, score: 0, reason: "Empty AI response", industry: "", potentialNeed: "", pitchAngle: "" });
    }

    let decision;
    try {
      const jsonMatch = content.match(/\{[\s\S]*\}/);
      decision = jsonMatch ? JSON.parse(jsonMatch[0]) : { qualified: false, score: 0, reason: "Could not parse response" };
    } catch {
      decision = { qualified: false, score: 0, reason: "Invalid JSON from AI" };
    }

    return res.status(200).json({
      lead,
      qualified: Boolean(decision.qualified),
      score: Math.min(10, Math.max(0, parseInt(decision.score) || 0)),
      reason: String(decision.reason || "").substring(0, 200),
      industry: String(decision.industry || ""),
      potentialNeed: String(decision.potentialNeed || ""),
      pitchAngle: String(decision.pitchAngle || "")
    });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
});

async function analyzeWebsiteSEO(url) {
  if (!url) return null;

  try {
    const resp = await axios.get(url, {
      timeout: 10000,
      maxRedirects: 5,
      headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36" }
    });
    const html = typeof resp.data === "string" ? resp.data : "";
    const $ = cheerio.load(html);

    const title = $("title").text().trim();
    const metaDesc = $('meta[name="description"]').attr("content") || "";
    const h1Count = $("h1").length;
    const imgNoAlt = $("img:not([alt])").length;
    const imgTotal = $("img").length;
    const links = $("a[href]").length;
    const hasViewport = !!$('meta[name="viewport"]').length;
    const hasSchema = html.includes("application/ld+json");
    const hasSitemap = html.includes("sitemap");
    const loadTime = resp.headers["x-response-time"] || "unknown";

    return {
      title,
      metaDescription: metaDesc.substring(0, 160),
      h1Count,
      imagesTotal: imgTotal,
      imagesWithoutAlt: imgNoAlt,
      totalLinks: links,
      hasViewport,
      hasSchemaMarkup: hasSchema,
      hasSitemapReference: hasSitemap,
      htmlSize: Math.round(html.length / 1024) + "KB"
    };
  } catch {
    return null;
  }
}

async function groqScoreSEO(lead, seoData) {
  if (!groq || !seoData) return null;

  const prompt = `Rate this website SEO 1-10 and overall 1-10. Business: ${lead.name}. Title: "${seoData.title || 'none'}". Meta: "${(seoData.metaDescription || 'none').substring(0,80)}". H1: ${seoData.h1Count}. Images: ${seoData.imagesTotal}(${seoData.imagesWithoutAlt} no alt). Mobile: ${seoData.hasViewport}. Schema: ${seoData.hasSchemaMarkup}. Return JSON: {"seoScore":N,"overallScore":N,"seoIssues":["i1"],"improvements":["f1"],"summary":"text"}`;

  const res = await groq.chat.completions.create({
    messages: [{ role: "user", content: prompt }],
    model: "openai/gpt-oss-20b",
    temperature: 0.2,
    max_tokens: 250
  });

  const txt = res.choices[0]?.message?.content || "";
  const m = txt.match(/\{[\s\S]*\}/);
  if (!m) return null;
  const p = JSON.parse(m[0]);
  return {
    seoScore: Math.min(10, Math.max(1, parseInt(p.seoScore) || 5)),
    overallScore: Math.min(10, Math.max(1, parseInt(p.overallScore) || 5)),
    seoIssues: Array.isArray(p.seoIssues) ? p.seoIssues.slice(0, 4) : [],
    improvements: Array.isArray(p.improvements) ? p.improvements.slice(0, 4) : [],
    summary: String(p.summary || "").substring(0, 150)
  };
}

function extractSocials(html) {
  const socials = {};

  const twitter = html.match(/twitter\.com\/([a-zA-Z0-9_]+)/i) || html.match(/x\.com\/([a-zA-Z0-9_]+)/i);
  if (twitter) socials.twitter = twitter[1];

  const linkedin = html.match(/linkedin\.com\/(in|company)\/([a-zA-Z0-9_-]+)/i);
  if (linkedin) socials.linkedin = linkedin[2];

  const instagram = html.match(/instagram\.com\/([a-zA-Z0-9_.]+)/i);
  if (instagram) socials.instagram = instagram[1];

  const facebook = html.match(/facebook\.com\/([a-zA-Z0-9.]+)/i);
  if (facebook) socials.facebook = facebook[1];

  const youtube = html.match(/youtube\.com\/(channel|c|@)\/([a-zA-Z0-9_-]+)/i);
  if (youtube) socials.youtube = youtube[2];

  return socials;
}

app.post("/api/enrich", async (req, res) => {
  const lead = req.body;
  if (!lead || !lead.name) return res.status(400).json({ error: "Lead with name required" });

  const enrichment = { emails: [], social: {}, website: lead.website || "", seoData: null, seoScores: null };

  try {
    // Step 1: Find website from DuckDuckGo if not available
    if (!enrichment.website) {
      const searchQuery = `"${lead.name}" ${lead.address || ""} official website`;
      const searchResp = await axios.get(`${DDG_URL}?q=${encodeURIComponent(searchQuery)}&kl=us-en`, { timeout: 15000 });
      const $ = cheerio.load(searchResp.data);

      const links = [];
      $(".result__url").each((_, el) => {
        const href = $(el).attr("href");
        if (href && !href.includes("duckduckgo") && !href.includes("google") && !href.includes("facebook.com/pages")) {
          links.push(href);
        }
      });

      if (links.length) enrichment.website = links[0];
    }

    // Step 2: Scrape the lead's own website for socials + emails
    if (enrichment.website) {
      try {
        const siteResp = await axios.get(enrichment.website, {
          timeout: 10000,
          maxRedirects: 5,
          headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36" }
        });
        const html = typeof siteResp.data === "string" ? siteResp.data : "";
        const $ = cheerio.load(html);

        // Extract emails from website
        const bodyText = $.text();
        const emails = bodyText.match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g) || [];
        enrichment.emails.push(...emails);

        // Also check mailto: links
        $('a[href^="mailto:"]').each((_, el) => {
          const email = $(el).attr("href").replace("mailto:", "").split("?")[0];
          if (email) enrichment.emails.push(email);
        });

        // Extract socials from website HTML
        const socials = extractSocials(html);
        Object.assign(enrichment.social, socials);

        // Also check href attributes for social links
        $('a[href*="twitter.com"], a[href*="x.com"]').each((_, el) => {
          const href = $(el).attr("href");
          const m = href.match(/(?:twitter\.com|x\.com)\/([a-zA-Z0-9_]+)/);
          if (m && !enrichment.social.twitter) enrichment.social.twitter = m[1];
        });
        $('a[href*="linkedin.com"]').each((_, el) => {
          const href = $(el).attr("href");
          const m = href.match(/linkedin\.com\/(in|company)\/([a-zA-Z0-9_-]+)/);
          if (m && !enrichment.social.linkedin) enrichment.social.linkedin = m[2];
        });
        $('a[href*="instagram.com"]').each((_, el) => {
          const href = $(el).attr("href");
          const m = href.match(/instagram\.com\/([a-zA-Z0-9_.]+)/);
          if (m && !enrichment.social.instagram) enrichment.social.instagram = m[1];
        });
        $('a[href*="facebook.com"]').each((_, el) => {
          const href = $(el).attr("href");
          const m = href.match(/facebook\.com\/([a-zA-Z0-9.]+)/);
          if (m && !enrichment.social.facebook) enrichment.social.facebook = m[1];
        });
        $('a[href*="youtube.com"]').each((_, el) => {
          const href = $(el).attr("href");
          const m = href.match(/youtube\.com\/(channel|c|@)\/([a-zA-Z0-9_-]+)/);
          if (m && !enrichment.social.youtube) enrichment.social.youtube = m[2];
        });

        // Get phone from website if not found
        if (!lead.phone) {
          const phoneMatch = html.match(/(\+?\d[\d\s\-()]{7,})/);
          if (phoneMatch) lead.phone = phoneMatch[1].trim();
        }

        // SEO analysis
        try {
          enrichment.seoData = await analyzeWebsiteSEO(enrichment.website);
          console.log("SEO data:", !!enrichment.seoData);
        } catch (e) { enrichment.seoData = null; console.log("SEO analysis error:", e.message); }

        // SEO scoring via Groq
        console.log("Checking SEO scoring:", !!enrichment.seoData, !!groq);
        if (enrichment.seoData && groq) {
          try {
            console.log("Calling groqScoreSEO...");
            const seoResult = await groqScoreSEO({ ...lead, website: enrichment.website }, enrichment.seoData);
            console.log("SEO result:", !!seoResult);
            enrichment.seoScores = seoResult;
          } catch (e) {
            console.log("SEO scoring error:", e.message);
            enrichment.seoScores = { error: e.message };
          }
        } else {
          console.log("Skipping SEO scoring - seoData:", !!enrichment.seoData, "groq:", !!groq);
          enrichment.seoScores = { error: "no seoData or groq" };
        }

      } catch { /* website not reachable */ }
    }

    // Step 3: DuckDuckGo fallback for more emails/socials
    const ddgQuery = `"${lead.name}" ${lead.address || ""} email contact`;
    const ddgResp = await axios.get(`${DDG_URL}?q=${encodeURIComponent(ddgQuery)}&kl=us-en`, { timeout: 12000 });
    const $$ = cheerio.load(ddgResp.data);

    const ddgLinks = [];
    $$(".result__url").each((_, el) => {
      const href = $$(el).attr("href");
      if (href && !href.includes("duckduckgo")) ddgLinks.push(href);
    });

    for (const url of [...new Set(ddgLinks)].slice(0, 3)) {
      if (url === enrichment.website) continue;
      try {
        const pageResp = await axios.get(url, { timeout: 6000, maxRedirects: 3, headers: { "User-Agent": "Mozilla/5.0" } });
        const text = typeof pageResp.data === "string" ? pageResp.data : "";

        const emails = text.match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g) || [];
        enrichment.emails.push(...emails);

        const socials = extractSocials(text);
        if (socials.twitter && !enrichment.social.twitter) enrichment.social.twitter = socials.twitter;
        if (socials.linkedin && !enrichment.social.linkedin) enrichment.social.linkedin = socials.linkedin;
        if (socials.instagram && !enrichment.social.instagram) enrichment.social.instagram = socials.instagram;
        if (socials.facebook && !enrichment.social.facebook) enrichment.social.facebook = socials.facebook;
        if (socials.youtube && !enrichment.social.youtube) enrichment.social.youtube = socials.youtube;
      } catch { continue; }
    }

    enrichment.emails = [...new Set(enrichment.emails)].filter(e => !e.includes("sentry.io") && !e.includes("wixpress") && !e.includes("example.com") && !e.includes("sentry-next.wixpress.com")).slice(0, 8);
    enrichment.sourceUrl = lead.url || "";

    return res.status(200).json({
      lead,
      enrichment: {
        emails: enrichment.emails,
        social: enrichment.social,
        website: enrichment.website,
        seoData: enrichment.seoData,
        seoScores: enrichment.seoScores,
        sourceUrl: enrichment.sourceUrl
      }
    });
  } catch (error) {
    return res.status(200).json({
      lead,
      enrichment: { emails: [], social: {}, website: lead.website || "", seoData: null, seoScores: null, sourceUrl: "" },
      error: error.message
    });
  }
});

export default app;