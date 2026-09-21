export default function handler(req, res) {
  res.status(200).json({
    name: "Leads Scraper API",
    version: "1.2.0",
    endpoints: {
      scrape: "POST /api/scrape",
      filter: "POST /api/filter",
      enrich: "POST /api/enrich",
      "validate-emails": "POST /api/validate-emails (MailRook email validation, 25 free/day)"
    }
  });
}
