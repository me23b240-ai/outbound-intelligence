import { Router } from "express";
import { z } from "zod";
import { env } from "./env.js";
import { tavilySearch, SearchError } from "./search.js";

export const linkedin = Router();

export function parseLinkedInUrl(raw) {
  try {
    const u = new URL(String(raw).trim());
    if (!/(^|\.)linkedin\.com$/i.test(u.hostname)) return null;
    const m = u.pathname.match(/^\/in\/([^/]+)/i);
    if (!m) return null;
    const slug = decodeURIComponent(m[1]).toLowerCase();
    return { slug, url: `https://www.linkedin.com/in/${slug}` };
  } catch {
    return null;
  }
}

const tidy = (s) => String(s ?? "").replace(/\s+/g, " ").replace(/\s*\((?:he|she|they)\/[^)]*\)/i, "").replace(/[.\u2026]+$/, "").trim();

// Public search results show a profile as "Name - Title - Company | LinkedIn" or "Name - Title at Company | LinkedIn".
export function parseLinkedInResult(title, content) {
  const t = tidy(String(title ?? "").replace(/\s*[|\u2013\u2014-]\s*LinkedIn\s*$/i, ""));
  const parts = t.split(/\s+[-\u2013\u2014]\s+/).map(tidy).filter(Boolean);
  let name = parts[0] ?? null;
  let role = null;
  let company = null;
  if (parts.length >= 3) {
    role = parts.slice(1, -1).join(" - ");
    company = parts[parts.length - 1];
  } else if (parts.length === 2) {
    const m = parts[1].match(/^(.*?)\s+(?:at|@)\s+(.+)$/i);
    if (m) { role = tidy(m[1]); company = tidy(m[2]); } else role = parts[1];
  }
  if (!company) {
    const exp = String(content ?? "").match(/Experience:\s*([^\u00B7|\n]+)/i);
    if (exp) company = tidy(exp[1]);
  }
  if (!role) {
    const m = String(content ?? "").match(/^(.{3,80}?)\s+(?:at|@)\s+([^.\u00B7|\n]{2,60})/i);
    if (m && !company) { role = tidy(m[1]); company = tidy(m[2]); }
  }
  const location = tidy((String(content ?? "").match(/Location:\s*([^\u00B7|\n]+)/i) ?? [])[1] ?? "") || null;
  return { name: name || null, role: role || null, company: company || null, location };
}

const nameFromSlug = (slug) =>
  slug.split("-").filter((w) => w && !/\d/.test(w)).map((w) => w[0].toUpperCase() + w.slice(1)).join(" ");

linkedin.post("/linkedin/lookup", async (req, res) => {
  const body = z.object({ url: z.string().trim().min(10).max(300) }).strict().safeParse(req.body);
  const fail = (status, code, message) => res.status(status).json({ error: { code, message } });
  if (!body.success) return fail(400, "invalid_input", "Paste a LinkedIn profile link.");
  const parsed = parseLinkedInUrl(body.data.url);
  if (!parsed) return fail(400, "invalid_input", "That is not a LinkedIn profile link. It should look like linkedin.com/in/name.");
  if (!env.TAVILY_API_KEY) return fail(503, "not_configured", "TAVILY_API_KEY is not set in .env.");

  try {
    const words = parsed.slug.split("-").filter((w) => w && !/\d/.test(w)).join(" ");
    const r = await tavilySearch({
      prospectId: null, stage: "linkedin", query: `${words} LinkedIn profile`, topic: "general", maxResults: 8, includeDomains: ["linkedin.com"],
    });
    const hit = r.results.find((x) => parseLinkedInUrl(x.url)?.slug === parsed.slug);
    if (!hit) {
      return fail(404, "not_found", "That profile did not appear in public search results. LinkedIn does not let apps read profiles directly, so please type the details in.");
    }
    const info = parseLinkedInResult(hit.title, hit.content);
    if (!info.name) info.name = nameFromSlug(parsed.slug) || null;
    if (!info.name) return fail(404, "not_found", "Could not read a name from that profile. Please type the details in.");
    res.json({
      linkedin_url: parsed.url,
      ...info,
      confidence: info.company && info.role ? "good" : info.company || info.role ? "partial" : "name_only",
      source: { title: hit.title, url: hit.url },
    });
  } catch (e) {
    const quota = e instanceof SearchError && e.code === "search_quota";
    fail(quota ? 429 : 502, e.code ?? "lookup_failed", "LinkedIn lookup failed: " + e.message);
  }
});
