import { Router } from "express";
import { z } from "zod";
import { db } from "./db.js";

export const prospects = Router();

const SUFFIX = /\b(inc|llc|ltd|limited|pvt|private|corp|corporation|co|plc|gmbh)\b/g;
export const clean = (s) =>
  String(s ?? "").toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, " ").replace(/\s+/g, " ").trim();
export const normCompany = (s) => clean(s).replace(SUFFIX, "").replace(/\s+/g, " ").trim();

// Shared by manual add, import and corrections so the keys always match.
export function normalizedFields({ full_name, company, email }) {
  const name_normalized = clean(full_name);
  const company_normalized = normCompany(company);
  return {
    name_normalized,
    company_normalized,
    email_normalized: email ? String(email).trim().toLowerCase() : null,
    dedupe_key: `${name_normalized}|${company_normalized}`,
  };
}

export const createSchema = z
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
  const { data, error } = await db
    .from("prospects")
    .insert({
      full_name: p.full_name,
      company_claimed: p.company,
      designation: p.designation ?? null,
      email: p.email ?? null,
      linkedin_url: p.linkedin_url ?? null,
      ...normalizedFields(p),
    })
    .select()
    .single();

  if (error) {
    if (error.code === "23505") {
      return res.status(409).json({
        error: { code: "duplicate", message: "This prospect already exists (same email, or same name and company)" },
      });
    }
    return res.status(500).json({ error: { code: "db_error", message: error.message } });
  }
  res.status(201).json({ prospect: data });
});

prospects.get("/", async (req, res) => {
  const { data, error } = await db
    .from("prospects")
    .select("id, full_name, company_claimed, designation, email, verification_status, research_status, draft_status, source, created_at")
    .is("archived_at", null)
    .order("created_at", { ascending: false });
  if (error) return res.status(500).json({ error: { code: "db_error", message: error.message } });

  let runs = [];
  if (data.length) {
    const r = await db
      .from("runs")
      .select("id, prospect_id, status, current_stage, needs_input_reason, trigger, started_at")
      .in("prospect_id", data.map((p) => p.id))
      .order("started_at", { ascending: false });
    runs = r.data ?? [];
  }
  const latest = new Map();
  for (const r of runs) if (!latest.has(r.prospect_id)) latest.set(r.prospect_id, r);
  res.json({ prospects: data.map((p) => ({ ...p, latest_run: latest.get(p.id) ?? null })) });
});
