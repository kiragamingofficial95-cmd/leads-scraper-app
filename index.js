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
    await page.setUserAgent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36");
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

        results.push({ name, rating, reviews, category, address, phone, url, website: "" });
      });

      return results;
    });

    for (let i = 0; i < leads.length; i++) {
      const lead = leads[i];
      if (!lead.url) continue;
      try {
        await page.goto(lead.url, { waitUntil: "domcontentloaded", timeout: 20000 });
        await new Promise(r => setTimeout(r, 3000));

        const website = await page.evaluate(() => {
          const authorityEl = document.querySelector('a[data-item-id="authority"]');
          if (authorityEl && authorityEl.href && !authorityEl.href.includes("google.com/maps")) {
            return authorityEl.href;
          }

          const btns = document.querySelectorAll('button[data-item-id="authority"], a[data-item-id="authority"]');
          for (const btn of btns) {
            const h = btn.href || btn.getAttribute("data-href") || "";
            if (h && !h.includes("google.com/maps")) return h;
          }

          const ariaLinks = document.querySelectorAll('a[aria-label]');
          for (const a of ariaLinks) {
            const label = (a.getAttribute("aria-label") || "").toLowerCase();
            if (label.includes("website") && a.href && !a.href.includes("google.com/maps")) {
              return a.href;
            }
          }

          const mainPanel = document.querySelector('[role="main"]');
          if (mainPanel) {
            const links = mainPanel.querySelectorAll('a[href]');
            for (const link of links) {
              const href = link.href;
              if (href
                && !href.includes("google.com")
                && !href.includes("gstatic.com")
                && !href.includes("googleapis.com")
                && !href.includes("youtube.com")
                && !href.includes("maps")) {
                return href;
              }
            }
          }

          return "";
        });

        if (website) lead.website = website;
      } catch {
        // listing page failed to load, skip
      }
    }

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

  if (!groq) {
    const score = (!lead.website || lead.website === "") ? 8 : (parseFloat(lead.rating) >= 4 ? 7 : 5);
    const reason = !lead.website
      ? "No website — high priority for web development pitch"
      : parseFloat(lead.rating) >= 4
        ? "Established business with good reviews, potential for web redesign"
        : "Local business that could benefit from web development services";
    return res.status(200).json({
      lead,
      qualified: true,
      score,
      reason,
      industry: lead.category || "",
      potentialNeed: !lead.website ? "Full website creation" : "Website redesign or web app",
      pitchAngle: !lead.website
        ? `Help ${lead.name} establish an online presence with a professional website`
        : `Offer ${lead.name} a modern website redesign to improve their online presence`
    });
  }

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

Qualification Rules — default to YES (qualified=true) unless the business is clearly unsuitable:
- Almost all local businesses need web dev services, so qualify them
- Businesses WITHOUT a website are HIGH priority (score 8-10)
- Businesses with a website but poor rating or few reviews are MEDIUM priority (score 5-7)
- Businesses with good ratings are GOOD candidates for a website redesign (score 6-8)
- Only disqualify if: it's a government agency, a massive corporation, or clearly not a real business
- When in doubt, qualify the lead

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
      return res.status(200).json({ lead, qualified: true, score: 6, reason: "AI response empty — defaulting to qualified", industry: lead.category || "", potentialNeed: "Website creation or redesign", pitchAngle: `Pitch web development services to ${lead.name}` });
    }

    let decision;
    try {
      const jsonMatch = content.match(/\{[\s\S]*\}/);
      decision = jsonMatch ? JSON.parse(jsonMatch[0]) : { qualified: true, score: 6, reason: "Parsed from AI response" };
    } catch {
      decision = { qualified: true, score: 6, reason: "AI response parsed with defaults" };
    }

    return res.status(200).json({
      lead,
      qualified: Boolean(decision.qualified),
      score: Math.min(10, Math.max(1, parseInt(decision.score) || 6)),
      reason: String(decision.reason || "").substring(0, 200),
      industry: String(decision.industry || ""),
      potentialNeed: String(decision.potentialNeed || ""),
      pitchAngle: String(decision.pitchAngle || "")
    });
  } catch (error) {
    const score = (!lead.website || lead.website === "") ? 8 : 6;
    return res.status(200).json({
      lead,
      qualified: true,
      score,
      reason: `API error — defaulting to qualified: ${error.message}`.substring(0, 200),
      industry: lead.category || "",
      potentialNeed: !lead.website ? "Full website creation" : "Website redesign",
      pitchAngle: `Pitch web development services to ${lead.name}`
    });
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
  if (!seoData) return null;

  let seoScore = 5;
  let issues = [];
  let improvements = [];

  if (!seoData.title || seoData.title.length < 10) { seoScore -= 2; issues.push("Missing or short title tag"); }
  else if (seoData.title.length > 60) { seoScore -= 1; issues.push("Title tag too long"); }

  if (!seoData.metaDescription) { seoScore -= 2; issues.push("No meta description"); }
  else if (seoData.metaDescription.length < 50) { seoScore -= 1; issues.push("Meta description too short"); }

  if (seoData.h1Count === 0) { seoScore -= 2; issues.push("No H1 tag found"); }
  else if (seoData.h1Count > 1) { seoScore -= 1; issues.push("Multiple H1 tags"); }

  if (seoData.imagesWithoutAlt > 0) { seoScore -= 1; issues.push(`${seoData.imagesWithoutAlt} images missing alt text`); }
  if (!seoData.hasViewport) { seoScore -= 2; issues.push("No mobile viewport"); improvements.push("Add viewport meta tag"); }
  if (!seoData.hasSchemaMarkup) { seoScore -= 1; issues.push("No schema markup"); improvements.push("Add structured data"); }
  if (seoData.htmlSize && parseInt(seoData.htmlSize) > 500) { seoScore -= 1; issues.push("Heavy page size"); }

  if (seoData.title && seoData.title.length >= 10 && seoData.title.length <= 60) improvements.push("Good title length");
  if (seoData.metaDescription && seoData.metaDescription.length >= 50) improvements.push("Good meta description");
  if (seoData.h1Count === 1) improvements.push("Proper H1 structure");
  if (seoData.hasViewport) improvements.push("Mobile-friendly viewport");
  if (seoData.hasSchemaMarkup) improvements.push("Has structured data");
  if (seoData.imagesWithoutAlt === 0 && seoData.imagesTotal > 0) improvements.push("All images have alt text");

  seoScore = Math.min(10, Math.max(1, seoScore));

  let overallScore = seoScore;
  if (lead.rating) overallScore = Math.round((seoScore + parseFloat(lead.rating)) / 2);
  overallScore = Math.min(10, Math.max(1, overallScore));

  let summary = `${lead.name || 'Business'} has a ${seoScore >= 7 ? 'good' : seoScore >= 4 ? 'moderate' : 'poor'} web presence. `;
  if (issues.length > 0) summary += `Key issues: ${issues.slice(0, 2).join(', ')}. `;
  if (!lead.website) summary += "No website found - high priority for web development pitch.";

  return { seoScore, overallScore, seoIssues: issues.slice(0, 4), improvements: improvements.slice(0, 4), summary: summary.substring(0, 200) };
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
        } catch (e) { enrichment.seoData = null; }

        // SEO scoring
        if (enrichment.seoData) {
          try {
            enrichment.seoScores = await groqScoreSEO({ ...lead, website: enrichment.website }, enrichment.seoData);
          } catch (e) {
            enrichment.seoScores = null;
          }
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