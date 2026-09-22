import Groq from "groq-sdk";

export const maxDuration = 30;

const GROQ_MODELS = ["llama-3.3-70b-versatile", "llama-3.1-8b-instant", "mixtral-8x7b-32768"];

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

function ruleBasedQualify(lead) {
  const name = (lead.name || "").toLowerCase();
  const category = (lead.category || "").toLowerCase();
  const text = `${name} ${category}`;

  const excluded = ["government", "municipal", "police station", "post office", "railway station", "bus stand", "public school", "ngo", "temple", "mosque", "church ", "gurudwara", "gram panchayat", "court"];
  for (const ex of excluded) {
    if (text.includes(ex)) {
      return { qualified: false, score: 2, reason: "Public/government entity - not a web dev prospect", industry: lead.category || "Public", potentialNeed: "None" };
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
    potentialNeed: need
  };
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

  if (!process.env.GROQ_API_KEY) {
    return res.status(200).json({ lead, ...ruleBasedQualify(lead), fallback: "rule-based (no GROQ_API_KEY)" });
  }

  try {
    const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });
    const prompt = `You are a B2B lead qualification expert. A web development agency wants to pitch their services (website design, web apps, ecommerce, SEO) to local businesses.

Analyze this business lead:

Name: ${lead.name || "N/A"}
Address: ${lead.address || "N/A"}
Phone: ${lead.phone || "N/A"}
Rating: ${lead.rating || "N/A"}
Reviews: ${lead.reviews || "N/A"}
Category: ${lead.category || "N/A"}

Determine if this is a QUALIFIED B2B prospect for software/web development services.

Qualification Criteria:
- Does this business likely need a website or web app? (Most local businesses do!)
- Are they established enough to afford web dev services?
- Is their industry a good fit for web development?
- If they have no website or a poor one, they are HIGH priority.
- When in doubt, QUALIFY them. Restaurants, salons, dentists, lawyers, contractors, shops, gyms — all qualify.
- Only mark as NOT qualified if the business is clearly not real, or is a government/nonprofit entity.

Return ONLY valid JSON with these fields:
{
  "qualified": true or false,
  "score": 1-10,
  "reason": "Brief explanation max 30 words",
  "industry": "Detected industry",
  "potentialNeed": "What software service they might need"
}`;

    let content = "";
    let lastError = "";
    for (const model of GROQ_MODELS) {
      try {
        const completion = await groq.chat.completions.create({
          messages: [{ role: "user", content: prompt }],
          model,
          temperature: 0.3,
          max_tokens: 500
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
      decision = jsonMatch ? JSON.parse(jsonMatch[0]) : { qualified: false, reason: "Could not parse response" };
    } catch {
      decision = { qualified: false, score: 0, reason: "Invalid AI response format" };
    }

    if (!decision.reason && !decision.industry && !decision.score) {
      return res.status(200).json({ lead, ...ruleBasedQualify(lead), fallback: "rule-based (AI unparseable)" });
    }

    return res.status(200).json({
      lead,
      ...decision
    });
  } catch (error) {
    return res.status(200).json({ lead, ...ruleBasedQualify(lead), fallback: "rule-based (error: " + error.message + ")" });
  }
}
