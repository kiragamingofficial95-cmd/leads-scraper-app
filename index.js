import express from "express";
import axios from "axios";
import * as cheerio from "cheerio";
import Groq from "groq-sdk";

const app = express();
app.use(express.json());

const GROQ_API_KEY = process.env.GROQ_API_KEY;
const groq = GROQ_API_KEY ? new Groq({ apiKey: GROQ_API_KEY }) : null;
const GOOGLE_MAPS_URL = "https://www.google.com/maps/search/";
const DDG_URL = "https://html.duckduckgo.com/html/";

app.get("/", (req, res) => {
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

  try {
    const search = encodeURIComponent(`${query} in ${location}`);
    const resp = await axios.get(`https://www.google.com/maps/search/${search}`, {
      headers: { "User-Agent": "Mozilla/5.0" }
    });
    return res.status(200).json({ message: "Use /api/scrape endpoint with proper browser support", query, location });
  } catch (error) {
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
      model: "llama-3.3-70b-versatile",
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