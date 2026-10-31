import { Router } from "express";
import { z } from "zod";
import { db } from "./db.js";

export const prospects = Router();

const SUFFIX = /\b(inc|llc|ltd|limited|pvt|private|corp|corporation|co|plc|gmbh)\b/g;
const clean = (s) =>
  s.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, " ").replace(/\s+/g, " ").trim();
const normCompany = (s) => clean(s).replace(SUFFIX, "").replace(/\s+/g, " ").trim();

const createSchema = z
  .object({
    full_name: z.string().trim().min(2).max(200),
    company: z.string().trim().min(2).max(200),
    designation: z.string().trim().max(200).optional(),
    email: z.string().trim().email().optional(),
    linkedin_url: z.string().trim().url().optional(),
  })
  .strict();

prospects.post("/", async (req, res) => {
  const parsed = createSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({
      error: {
        code: "invalid_input",
        message: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "),
      },
    });
  }
  const p = parsed.data;
  const name_normalized = clean(p.full_name);
  const company_normalized = normCompany(p.company);

  const { data, error } = await db
    .from("prospects")
    .insert({
      full_name: p.full_name,
      company_claimed: p.company,
      designation: p.designation ?? null,
      email: p.email ?? null,
      linkedin_url: p.linkedin_url ?? null,
      name_normalized,
      company_normalized,
      email_normalized: p.email ? p.email.toLowerCase() : null,
      dedupe_key: `${name_normalized}|${company_normalized}`,
    })
    .select()
    .single();

  if (error) {
    if (error.code === "23505") {
      return res.status(409).json({
        error: { code: "duplicate", message: "This prospect already exists (same email or name and company)" },
      });
    }
    return res.status(500).json({ error: { code: "db_error", message: error.message } });
  }
  res.status(201).json({ prospect: data });
});

prospects.get("/", async (req, res) => {
  const { data, error } = await db
    .from("prospects")
    .select("id, full_name, company_claimed, designation, email, verification_status, research_status, draft_status, created_at")
    .is("archived_at", null)
    .order("created_at", { ascending: false });
  if (error) {
    return res.status(500).json({ error: { code: "db_error", message: error.message } });
  }
  res.json({ prospects: data });
});
