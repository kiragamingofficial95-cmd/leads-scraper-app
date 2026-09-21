import axios from "axios";

const DAILY_LIMIT = 25;
const MAILROOK_BASE = "https://api.mailrook.com";

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const { emails } = req.body;
  if (!emails || !Array.isArray(emails) || emails.length === 0) {
    return res.status(400).json({ error: "Provide an array of email addresses" });
  }

  const MAILROOK_API_KEY = process.env.MAILROOK_API_KEY;
  if (!MAILROOK_API_KEY) {
    return res.status(500).json({ error: "MAILROOK_API_KEY not configured. Get a free key at https://mailrook.com/account/signup" });
  }

  const uniqueEmails = [...new Set(emails.filter(e => e && e.includes("@")))];
  const toValidate = uniqueEmails.slice(0, DAILY_LIMIT);
  const skipped = uniqueEmails.length - toValidate.length;

  const results = [];

  for (const email of toValidate) {
    try {
      const resp = await axios.get(`${MAILROOK_BASE}/v1/validate/${encodeURIComponent(email)}`, {
        headers: { Authorization: `Bearer ${MAILROOK_API_KEY}` },
        timeout: 15000
      });

      const d = resp.data?.data || {};

      results.push({
        email: d.email || email,
        normalizedEmail: d.normalized_email || "",
        result: d.result || "unknown",            // deliverable | undeliverable | risky | unknown
        score: d.score ?? null,                    // 0-100
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

      // Read remaining credits from headers
      const remaining = resp.headers["x-credits-remaining"];
      const freeToday = resp.headers["x-credits-free-today"];
      if (remaining !== undefined) results._remaining = parseInt(remaining);
      if (freeToday !== undefined) results._freeToday = parseInt(freeToday);

    } catch (err) {
      const status = err.response?.status;
      const errData = err.response?.data;

      if (status === 402) {
        // Out of credits — stop processing
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
        // Stop processing remaining emails
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
      remainingToday: results._freeToday ?? Math.max(0, DAILY_LIMIT - results.length),
      dailyLimit: DAILY_LIMIT
    }
  });
}
