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
const MAILROOK_API_KEY = process.env.MAILROOK_API_KEY || "209|tlNYK6t2OlmivhEJIzx3qTwq397cHAzujMyknDCP425d5316";
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

  // Support both single string and array of queries
  const queries = Array.isArray(query) ? query.filter(q => q && q.trim()) : [query];
  if (queries.length === 0) return res.status(400).json({ error: "At least one query required" });

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

    // Extract leads from current Google Maps page
    async function extractLeads(searchQuery) {
      const search = encodeURIComponent(`${searchQuery} in ${location}`);
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

      return await page.evaluate((keyword) => {
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

          results.push({ name, rating, reviews, category, address, phone, url, website, searchKeyword: keyword });
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
      } catch (err) {
        // If one keyword fails, continue with the rest
        continue;
      }
    }

    await browser.close();
    return res.status(200).json({ leads: allLeads, queries, location });
  } catch (error) {
    if (browser) await browser.close().catch(() => {});
    return res.status(500).json({ error: error.message });
  }
});

app.post("/api/filter", async (req, res) => {
  const lead = req.body;
  if (!lead || !lead.name) return res.status(400).json({ error: "Lead with name required" });
  if (!groq) return res.status(500).json({ error: "GROQ_API_KEY not configured" });

  const hasWebsite = !!(lead.website && lead.website.trim());

  try {
    const prompt = `You are a STRICT B2B lead qualification expert for a web development agency that sells: website design, web apps, ecommerce stores, and SEO services.

Analyze this business lead and determine if they are a PROSPECT who NEEDS web development services.

Lead Info:
- Business Name: ${lead.name || "N/A"}
- Category/Industry: ${lead.category || "N/A"}
- Address: ${lead.address || "N/A"}
- Phone: ${lead.phone || "N/A"}
- Rating: ${lead.rating || "N/A"}
- Reviews: ${lead.reviews || "N/A"}
- Website: ${hasWebsite ? lead.website : "NONE — no website found"}

STRICT QUALIFICATION RULES:
- A business with NO WEBSITE is HIGH PRIORITY (score 7-10) — they need one urgently.
- A business with a WEBSITE but POOR SEO (no meta description, no mobile viewport, bad title, missing alt text) is a GOOD PROSPECT for SEO/redo services (score 5-7).
- A business with a GOOD WEBSITE and GOOD SEO is NOT a good prospect — they already have what you're selling (score 1-3, qualified: false).
- Mass retailers, chains, government offices, schools, and churches are generally NOT good prospects (score 1-3).
- Established local service businesses (restaurants, salons, dentists, contractors, clinics, gyms, repair shops) WITH poor or no web presence are IDEAL prospects.

Return ONLY valid JSON:
{
  "qualified": true only if score >= 5,
  "score": 1-10,
  "reason": "One clear sentence explaining WHY this score. Must mention specific issues like: no website, missing SEO elements, outdated site, poor mobile experience, etc.",
  "industry": "Detected industry",
  "potentialNeed": "Specific service they need (e.g. 'Full website build', 'SEO overhaul', 'Ecommerce store', 'Website redesign')",
  "pitchAngle": "One-sentence approach for pitching them"
}`;

    const completion = await groq.chat.completions.create({
      messages: [{ role: "user", content: prompt }],
      model: "llama3-70b-8192",
      temperature: 0.2,
      max_tokens: 500
    });

    const content = completion.choices[0]?.message?.content;

    if (!content || !content.trim()) {
      const fallbackScore = hasWebsite ? 3 : 8;
      return res.status(200).json({
        lead,
        qualified: fallbackScore >= 5,
        score: fallbackScore,
        reason: hasWebsite
          ? "AI unavailable — has website, likely already has web presence"
          : "AI unavailable — no website detected, high priority prospect",
        industry: lead.category || "",
        potentialNeed: hasWebsite ? "SEO audit and improvement" : "Full website build",
        pitchAngle: hasWebsite
          ? "Offer SEO audit to improve their search rankings"
          : "Offer a complete website build — they have no online presence"
      });
    }

    let decision;
    try {
      const jsonMatch = content.match(/\{[\s\S]*\}/);
      decision = jsonMatch ? JSON.parse(jsonMatch[0]) : null;
    } catch {
      decision = null;
    }

    if (!decision) {
      const fallbackScore = hasWebsite ? 3 : 8;
      return res.status(200).json({
        lead,
        qualified: fallbackScore >= 5,
        score: fallbackScore,
        reason: `AI response unparseable. ${hasWebsite ? "Has website — lower priority." : "No website — high priority prospect."}`,
        industry: lead.category || "",
        potentialNeed: hasWebsite ? "SEO audit" : "Full website build",
        pitchAngle: hasWebsite ? "Offer SEO services" : "Offer a complete website"
      });
    }

    const score = Math.min(10, Math.max(1, parseInt(decision.score) || 0));
    const qualified = score >= 5;

    let reason = String(decision.reason || "").substring(0, 200);
    if (!reason || reason.length < 10) {
      reason = hasWebsite
        ? `Score ${score}/10 — has website, ${score >= 5 ? "poor SEO needs improvement" : "adequate web presence"}`
        : `Score ${score}/10 — no website detected, strong candidate for web development`;
    }

    return res.status(200).json({
      lead,
      qualified,
      score,
      reason,
      industry: String(decision.industry || lead.category || ""),
      potentialNeed: String(decision.potentialNeed || ""),
      pitchAngle: String(decision.pitchAngle || "")
    });
  } catch (error) {
    const fallbackScore = hasWebsite ? 3 : 7;
    return res.status(200).json({
      lead,
      qualified: fallbackScore >= 5,
      score: fallbackScore,
      reason: `Processing error. ${hasWebsite ? "Has website." : "No website detected — likely needs one."}`,
      industry: lead.category || "",
      potentialNeed: hasWebsite ? "SEO audit" : "Full website build",
      pitchAngle: hasWebsite ? "Offer SEO services" : "Offer a complete website",
      error: error.message
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

  // Title tag analysis
  if (!seoData.title || seoData.title.length === 0) {
    seoScore -= 3;
    issues.push("Missing title tag — critical for search rankings");
  } else if (seoData.title.length < 10) {
    seoScore -= 2;
    issues.push("Title tag too short (under 10 chars) — poor keyword targeting");
  } else if (seoData.title.length > 60) {
    seoScore -= 1;
    issues.push("Title tag over 60 chars — gets truncated in search results");
  } else {
    improvements.push("Title tag is good length");
  }

  // Meta description analysis
  if (!seoData.metaDescription) {
    seoScore -= 2;
    issues.push("No meta description — search snippets will be auto-generated and poor");
  } else if (seoData.metaDescription.length < 50) {
    seoScore -= 1;
    issues.push("Meta description too short — misses keyword opportunities");
  } else {
    improvements.push("Meta description present and good length");
  }

  // H1 analysis
  if (seoData.h1Count === 0) {
    seoScore -= 2;
    issues.push("No H1 heading — search engines can't determine page topic");
  } else if (seoData.h1Count > 1) {
    seoScore -= 1;
    issues.push("Multiple H1 tags — confuses search engine page structure");
  } else {
    improvements.push("Proper single H1 heading");
  }

  // Image alt text
  if (seoData.imagesWithoutAlt > 0 && seoData.imagesTotal > 0) {
    const pct = Math.round((seoData.imagesWithoutAlt / seoData.imagesTotal) * 100);
    seoScore -= 1;
    issues.push(`${seoData.imagesWithoutAlt}/${seoData.imagesTotal} images (${pct}%) missing alt text — hurts image SEO and accessibility`);
  } else if (seoData.imagesTotal > 0) {
    improvements.push("All images have alt text");
  }

  // Mobile viewport
  if (!seoData.hasViewport) {
    seoScore -= 2;
    issues.push("No mobile viewport tag — site is not mobile-friendly (60%+ traffic is mobile)");
    improvements.push("Add <meta name='viewport'> tag");
  } else {
    improvements.push("Mobile-friendly viewport present");
  }

  // Schema markup
  if (!seoData.hasSchemaMarkup) {
    seoScore -= 1;
    issues.push("No structured data/schema markup — missing rich snippet opportunities in Google");
    improvements.push("Add JSON-LD structured data");
  } else {
    improvements.push("Has schema/structured data markup");
  }

  // Page size
  if (seoData.htmlSize) {
    const sizeKB = parseInt(seoData.htmlSize);
    if (sizeKB > 500) {
      seoScore -= 1;
      issues.push(`Heavy HTML (${seoData.htmlSize}) — slow page load impacts SEO ranking`);
    } else if (sizeKB > 200) {
      issues.push(`Moderate page size (${seoData.htmlSize}) — could be optimized`);
    }
  }

  // Links
  if (seoData.totalLinks < 3) {
    seoScore -= 1;
    issues.push("Very few links — poor internal linking structure");
  }

  seoScore = Math.min(10, Math.max(1, seoScore));

  // Overall score — heavily weight no-website as a bonus
  let overallScore = seoScore;
  if (!lead.website) {
    // No website = automatic high opportunity score
    overallScore = Math.max(seoScore, 8);
    issues.unshift("NO WEBSITE DETECTED — business has no online presence");
  } else if (lead.rating) {
    overallScore = Math.round((seoScore + parseFloat(lead.rating)) / 2);
  }
  overallScore = Math.min(10, Math.max(1, overallScore));

  // Build clear summary
  let summary = `${lead.name || 'Business'}`;
  if (!lead.website) {
    summary += ` has NO WEBSITE. This is a prime prospect — they need a full web presence built from scratch.`;
  } else if (seoScore >= 7) {
    summary += ` has a decent website but could benefit from advanced SEO.`;
  } else if (seoScore >= 4) {
    summary += ` has a website with moderate SEO issues that need fixing.`;
  } else {
    summary += ` has a poorly optimized website that needs a major overhaul.`;
  }
  if (issues.length > 0) {
    summary += ` Main problems: ${issues.slice(0, 3).join('; ')}.`;
  }

  return {
    seoScore,
    overallScore,
    seoIssues: issues.slice(0, 5),
    improvements: improvements.slice(0, 5),
    summary: summary.substring(0, 300)
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

// ─── MailRook Email Validation ────────────────────────────────────────────────
// Rate-limited to 25/day (MailRook free tier cap)
const EMAIL_VALIDATION_DAILY_LIMIT = 25;
const MAILROOK_BASE = "https://api.mailrook.com";

app.post("/api/validate-emails", async (req, res) => {
  const { emails } = req.body;
  if (!emails || !Array.isArray(emails) || emails.length === 0) {
    return res.status(400).json({ error: "Provide an array of email addresses" });
  }

  const MAILROOK_API_KEY = process.env.MAILROOK_API_KEY || "209|tlNYK6t2OlmivhEJIzx3qTwq397cHAzujMyknDCP425d5316";
  if (!MAILROOK_API_KEY) {
    return res.status(500).json({ error: "MAILROOK_API_KEY not configured. Get a free key at https://mailrook.com/account/signup" });
  }

  const uniqueEmails = [...new Set(emails.filter(e => e && e.includes("@")))];
  const toValidate = uniqueEmails.slice(0, EMAIL_VALIDATION_DAILY_LIMIT);
  const skipped = uniqueEmails.length - toValidate.length;

  const results = [];
  let freeToday = EMAIL_VALIDATION_DAILY_LIMIT;

  for (const email of toValidate) {
    try {
      const resp = await axios.get(`${MAILROOK_BASE}/v1/validate/${encodeURIComponent(email)}`, {
        headers: { Authorization: `Bearer ${MAILROOK_API_KEY}` },
        timeout: 15000
      });

      const d = resp.data?.data || {};

      // Read remaining credits from response headers
      const remaining = resp.headers["x-credits-remaining"];
      const free = resp.headers["x-credits-free-today"];
      if (free !== undefined) freeToday = parseInt(free);

      results.push({
        email: d.email || email,
        normalizedEmail: d.normalized_email || "",
        result: d.result || "unknown",
        score: d.score ?? null,
        reason: d.reason || "",
        reasonLabel: d.reason_label || "",
        isFormat: d.isv_format ?? null,
        isDomain: d.isv_domain ?? null,
        isDeliverable: d.isv_deliverable ?? null,
        isNoCatchall: d.isv_nocatchall ?? null,
        isNoGeneric: d.isv_nogeneric ?? null,
        isNoDisposable: d.isv_nodisposable ?? null,
        isNoFreeEmail: d.isv_nofreeemail ?? null,
        isNoUniversity: d.isv_nouniversity ?? null,
        mxRecord: d.mx_record || null,
        provider: d.provider || null,
        protectionLevel: d.protection_level || null,
        emailSecurity: d.email_security || [],
        domainInfo: d.domain_info || null
      });
    } catch (err) {
      const status = err.response?.status;
      const errData = err.response?.data;

      if (status === 402) {
        results.push({
          email,
          result: "unknown",
          score: null,
          reason: "credits_exhausted",
          reasonLabel: errData?.details?.hint || "Daily free limit reached. Resets at midnight UTC.",
          isFormat: null, isDomain: null, isDeliverable: null,
          isNoCatchall: null, isNoGeneric: null, isNoDisposable: null,
          isNoFreeEmail: null, isNoUniversity: null,
          mxRecord: null, provider: null, protectionLevel: null,
          emailSecurity: [], domainInfo: null
        });
        break;
      }

      results.push({
        email,
        result: "unknown",
        score: null,
        reason: "api_error",
        reasonLabel: errData?.message || err.message || "Validation failed",
        isFormat: null, isDomain: null, isDeliverable: null,
        isNoCatchall: null, isNoGeneric: null, isNoDisposable: null,
        isNoFreeEmail: null, isNoUniversity: null,
        mxRecord: null, provider: null, protectionLevel: null,
        emailSecurity: [], domainInfo: null
      });
    }
  }

  const validCount = results.filter(r => r.result === "deliverable").length;
  const riskyCount = results.filter(r => r.result === "risky").length;
  const invalidCount = results.filter(r => r.result === "undeliverable").length;
  const unknownCount = results.filter(r => r.result === "unknown").length;
  const disposableCount = results.filter(r => r.isNoDisposable === false).length;

  return res.status(200).json({
    results,
    summary: {
      total: uniqueEmails.length,
      validated: results.length,
      valid: validCount,
      risky: riskyCount,
      invalid: invalidCount,
      unknown: unknownCount,
      disposable: disposableCount,
      skipped,
      remainingToday: freeToday,
      dailyLimit: EMAIL_VALIDATION_DAILY_LIMIT
    }
  });
});

export default app;