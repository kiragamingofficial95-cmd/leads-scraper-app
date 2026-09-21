import Groq from "groq-sdk";

const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

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

  if (!process.env.GROQ_API_KEY) {
    return res.status(500).json({ error: "GROQ_API_KEY not configured" });
  }

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
      // Fallback: score based on available data
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

    // Enforce: qualified must match score threshold
    const score = Math.min(10, Math.max(1, parseInt(decision.score) || 0));
    const qualified = score >= 5;

    // Ensure reason always explains the score
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
    // On error, still try to score based on website presence
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
}
