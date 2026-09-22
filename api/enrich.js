import axios from "axios";
import * as cheerio from "cheerio";

export const maxDuration = 30;

const SEARCH_URL = "https://html.duckduckgo.com/html/";
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36";

function extractSocials(text) {
  const social = {};
  const tw = text.match(/(?:twitter\.com|x\.com)\/([a-zA-Z0-9_]+)/i);
  if (tw) social.twitter = tw[1];
  const li = text.match(/linkedin\.com\/(in|company)\/([a-zA-Z0-9_-]+)/i);
  if (li) social.linkedin = li[2];
  const ig = text.match(/instagram\.com\/([a-zA-Z0-9_.]+)/i);
  if (ig) social.instagram = ig[1];
  const fb = text.match(/facebook\.com\/([a-zA-Z0-9.]+)/i);
  if (fb) social.facebook = fb[1];
  return social;
}

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
    website: lead.website || "",
    sourceUrl: lead.url || "",
  };

  try {
    // Step 1: if no website, one quick DDG lookup (8s cap)
    if (!enrichment.website) {
      try {
        const searchResp = await axios.get(
          `${SEARCH_URL}?q=${encodeURIComponent(`"${lead.name}" ${lead.address || ""} official website`)}&kl=us-en`,
          { timeout: 8000 }
        );
        const $ = cheerio.load(searchResp.data);
        $(".result__url").each((_, el) => {
          if (enrichment.website) return;
          const href = $(el).attr("href");
          if (href && !href.includes("duckduckgo") && !href.includes("google") && href.startsWith("http")) {
            enrichment.website = href;
          }
        });
      } catch {
        /* ignore - continue without website */
      }
    }

    // Step 2: fetch the business website once (6s cap) for emails + socials
    if (enrichment.website) {
      try {
        const siteResp = await axios.get(enrichment.website, {
          timeout: 6000,
          maxRedirects: 3,
          headers: { "User-Agent": UA },
        });
        const html = typeof siteResp.data === "string" ? siteResp.data : "";
        const emails = html.match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g) || [];
        enrichment.emails.push(...emails);
        Object.assign(enrichment.social, extractSocials(html));
      } catch {
        /* website unreachable - continue */
      }
    }

    enrichment.emails = [...new Set(enrichment.emails)]
      .filter((e) => !/sentry|wixpress|example\.com|godaddy|cloudflare/i.test(e))
      .slice(0, 5);

    return res.status(200).json({ lead, enrichment });
  } catch (error) {
    return res.status(200).json({
      lead,
      enrichment,
      error: error.message,
    });
  }
}
