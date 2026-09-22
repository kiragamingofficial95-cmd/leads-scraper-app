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

  try {
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
      decision = jsonMatch ? JSON.parse(jsonMatch[0]) : { qualified: false, reason: "Could not parse response" };
    } catch {
      decision = { qualified: false, score: 0, reason: "Invalid AI response format" };
    }

    return res.status(200).json({
      lead,
      ...decision
    });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
}