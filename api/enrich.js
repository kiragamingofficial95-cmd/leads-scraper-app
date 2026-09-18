import axios from "axios";
import * as cheerio from "cheerio";

const SEARCH_URL = "https://html.duckduckgo.com/html/";

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

  const lead = req.body;

  if (!lead || !lead.name) {
    return res.status(400).json({ error: "Lead data with name is required" });
  }

  const enrichment = {
    emails: [],
    social: {},
    website: "",
    additionalPhones: []
  };

  try {
    const searchQuery = `"${lead.name}" ${lead.address || ""} email contact`;
    const searchResp = await axios.get(`${SEARCH_URL}?q=${encodeURIComponent(searchQuery)}&kl=us-en`, {
      timeout: 15000
    });

    const $ = cheerio.load(searchResp.data);
    const links = [];

    $(".result__url").each((_, el) => {
      const href = $(el).attr("href");
      if (href && !href.includes("duckduckgo")) {
        links.push(href);
      }
    });

    const uniqueLinks = [...new Set(links)].slice(0, 5);

    for (const url of uniqueLinks) {
      try {
        const pageResp = await axios.get(url, {
          timeout: 8000,
          maxRedirects: 5,
          headers: {
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"
          }
        });

        const pageText = typeof pageResp.data === "string" ? pageResp.data : "";

        const emailRegex = /[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/g;
        const foundEmails = pageText.match(emailRegex) || [];
        enrichment.emails.push(...foundEmails);

        const twitterRegex = /twitter\.com\/([a-zA-Z0-9_]+)/gi;
        const twitterMatch = [...pageText.matchAll(twitterRegex)];
        if (twitterMatch.length) {
          enrichment.social.twitter = twitterMatch[0][1];
        }

        const linkedinRegex = /linkedin\.com\/(in|company)\/([a-zA-Z0-9\-]+)/gi;
        const linkedinMatch = [...pageText.matchAll(linkedinRegex)];
        if (linkedinMatch.length) {
          enrichment.social.linkedin = linkedinMatch[0][2];
        }

        const instagramRegex = /instagram\.com\/([a-zA-Z0-9_.]+)/gi;
        const instagramMatch = [...pageText.matchAll(instagramRegex)];
        if (instagramMatch.length) {
          enrichment.social.instagram = instagramMatch[0][1];
        }

        const facebookRegex = /facebook\.com\/([a-zA-Z0-9.]+)/gi;
        const facebookMatch = [...pageText.matchAll(facebookRegex)];
        if (facebookMatch.length) {
          enrichment.social.facebook = facebookMatch[0][1];
        }

        const websiteMatch = pageText.match(/https?:\/\/(www\.)?[a-zA-Z0-9\-]+\.[a-z]{2,}/);
        if (websiteMatch && !enrichment.website) {
          enrichment.website = websiteMatch[0];
        }
      } catch {
        continue;
      }
    }

    enrichment.emails = [...new Set(enrichment.emails)].slice(0, 5);
    enrichment.sourceUrl = lead.url || "";

    return res.status(200).json({ lead, enrichment });
  } catch (error) {
    return res.status(500).json({ error: error.message, enrichment });
  }
}