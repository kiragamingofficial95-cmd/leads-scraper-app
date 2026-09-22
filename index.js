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
      const seenNames = new Set();

      // Try multiple selectors for the feed container
      const feed = document.querySelector('[role="feed"]') || document.querySelector('.m6QErb.DxyBCb.kA9KIf.dS8AEf');
      if (!feed) return results;

      // Try multiple selectors for result items
      const items = feed.querySelectorAll(':scope > div > div') || feed.querySelectorAll('.Nv2PK');

      items.forEach(item => {
        // Try multiple selectors for the business name
        const nameEl = item.querySelector('.qBF1Pd, .fontHeadlineSmall, [class*="fontHeadlineSmall"], .NrDZNb, .dbg0pd');
        if (!nameEl) return;
        const name = nameEl.innerText.trim();
        if (!name || seenNames.has(name)) return;
        seenNames.add(name);

        const allText = item.innerText || "";
        const lines = allText.split('\n').map(l => l.trim()).filter(Boolean);
        let rating = "", reviews = "", category = "", address = "", phone = "", url = "", website = "";

        // Rating extraction
        const ratingMatch = allText.match(/(\d+\.?\d*)\s*stars?/i) || allText.match(/(\d+\.?\d*)\s*\(/);
        if (ratingMatch) rating = ratingMatch[1];

        // Reviews extraction
        const reviewsMatch = allText.match(/\((\d[\d,]*)\)/);
        if (reviewsMatch) reviews = reviewsMatch[1].replace(/,/g, "");

        // Maps link
        const linkEl = item.querySelector('a[href*="maps"], a.hfpxzc, a[data-item-id]');
        if (linkEl) url = linkEl.href;

        // Phone extraction
        const phoneMatch = allText.match(/(\+?\d[\d\s\-()]{7,})/);
        if (phoneMatch) phone = phoneMatch[1].trim();

        // Website extraction
        const webMatch = allText.match(/(?:https?:\/\/)?(?:www\.)?([a-zA-Z0-9-]+\.[a-z]{2,})/);
        if (webMatch && !webMatch[0].includes("google") && !webMatch[0].includes("gstatic")) {
          website = webMatch[0].startsWith("http") ? webMatch[0] : "https://" + webMatch[0];
        }

        // Address extraction - look for street-like patterns
        for (const line of lines) {
          if (!address && (line.includes("St") || line.includes("Rd") || line.includes("Ave") || line.includes("Dr") || line.includes("Blvd") || line.includes("Way") || line.includes("Ln") || line.includes("Suite") || line.includes("Ste") || line.includes(",") && /\d/.test(line) || /\d+.*(?:street|road|avenue|drive|boulevard|lane)/i.test(line))) {
            address = line;
          }
        }

        // Category extraction
        if (address && lines.indexOf(address) > 0) {
          const catLine = lines[lines.indexOf(address) - 1];
          if (catLine && catLine !== name && !catLine.match(/^\d/)) category = catLine;
        }

        // If no category found, try W4Efsd class
        if (!category) {
          const catEl = item.querySelector('.W4Efsd span:first-child, .DkEaL');
          if (catEl) {
            const catText = catEl.innerText.trim();
            if (catText && catText !== name) category = catText;
          }
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

function ruleBasedQualify(lead) {
  const name = (lead.name || "").toLowerCase();
  const category = (lead.category || "").toLowerCase();
  const text = `${name} ${category}`;

  const excluded = ["government", "municipal", "police station", "post office", "railway station", "bus stand", "public school", "ngo", "temple", "mosque", "church ", "gurudwara", "gram panchayat", "court"];
  for (const ex of excluded) {
    if (text.includes(ex)) {
      return { qualified: false, score: 2, reason: "Public/government entity - not a web dev prospect", industry: lead.category || "Public", potentialNeed: "None", pitchAngle: "" };
    }
  }

  let score = 6;
  if (!lead.website) score += 2;
  if (lead.phone) score += 1;
  const rating = parseFloat(lead.rating);
  if (!isNaN(rating) && rating >= 4) score += 1;
  const reviews = parseInt(String(lead.reviews || "").replace(/,/g, ""));
  if (!isNaN(reviews) && reviews >= 10) score += 1;
  score = Math.min(10, Math.max(1, score));

  const industry = lead.category || detectIndustry(text);
  const need = !lead.website ? "New business website + Google profile setup" : "Website redesign + SEO + lead generation";
  return {
    qualified: score >= 5,
    score,
    reason: !lead.website ? "No website found - high priority for web dev pitch" : "Local business likely needs better web presence and SEO",
    industry,
    potentialNeed: need,
    pitchAngle: `Offer ${need.toLowerCase()} to ${lead.name}`
  };
}

function detectIndustry(text) {
  if (/restaurant|cafe|food|bakery|pizza|diner|dhaba/.test(text)) return "Restaurant / Food";
  if (/salon|spa|barber|beauty|parlor/.test(text)) return "Salon / Beauty";
  if (/dent|clinic|doctor|hospital|physio|dental/.test(text)) return "Healthcare";
  if (/law|advocate|legal/.test(text)) return "Legal";
  if (/gym|fitness|yoga/.test(text)) return "Fitness";
  if (/hotel|guest|resort|stay/.test(text)) return "Hospitality";
  if (/school|coach|tuition|training|college/.test(text)) return "Education";
  if (/real estate|property|builder|construction|contractor|interior/.test(text)) return "Real Estate / Construction";
  if (/shop|store|retail|boutique|mart|jewel|fashion|clothing/.test(text)) return "Retail";
  if (/auto|car|garage|repair|service/.test(text)) return "Automotive Services";
  return "Local Business";
}

const GROQ_MODELS = ["llama-3.3-70b-versatile", "llama-3.1-8b-instant", "mixtral-8x7b-32768"];

app.post("/api/filter", async (req, res) => {
  const lead = req.body;
  if (!lead || !lead.name) return res.status(400).json({ error: "Lead with name required" });
  if (!groq) {
    return res.status(200).json({ lead, ...ruleBasedQualify(lead), fallback: "rule-based (no GROQ_API_KEY)" });
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

Qualification Criteria:
- Does this business likely need a website or web app? (Most local businesses do!)
- Are they established enough to afford web dev services?
- Is their industry a good fit for web development?
- If they have NO website or a poor one, they are HIGH priority.
- When in doubt, QUALIFY them. Most businesses benefit from web services.
- Restaurants, salons, dentists, lawyers, contractors, shops, gyms — all qualify.
- Only mark as NOT qualified if the business is clearly not real, or is a government/nonprofit entity.

Return ONLY valid JSON:
{
  "qualified": true/false,
  "score": 1-10,
  "reason": "Brief explanation max 30 words",
  "industry": "Detected industry",
  "potentialNeed": "Specific web dev service they need",
  "pitchAngle": "How to approach them for web dev pitch"
}`;

    let content = "";
    let lastError = "";
    for (const model of GROQ_MODELS) {
      try {
        const completion = await groq.chat.completions.create({
          messages: [{ role: "user", content: prompt }],
          model,
          temperature: 0.3,
          max_tokens: 600
        });
        content = completion.choices[0]?.message?.content || "";
        if (content) break;
      } catch (e) {
        lastError = e.message;
      }
    }

    if (!content) {
      return res.status(200).json({ lead, ...ruleBasedQualify(lead), fallback: "rule-based (AI failed: " + lastError + ")" });
    }

    let decision;
    try {
      const jsonMatch = content.match(/\{[\s\S]*\}/);
      decision = jsonMatch ? JSON.parse(jsonMatch[0]) : { qualified: false, score: 0, reason: "Could not parse response" };
    } catch {
      decision = { qualified: false, score: 0, reason: "Invalid JSON from AI" };
    }

    // If AI returned unparseable/empty result, fall back to rules so pipeline never yields 0
    if (!decision.reason && !decision.industry && !decision.score) {
      return res.status(200).json({ lead, ...ruleBasedQualify(lead), fallback: "rule-based (AI unparseable)" });
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
    return res.status(200).json({ lead, ...ruleBasedQualify(lead), fallback: "rule-based (error: " + error.message + ")" });
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