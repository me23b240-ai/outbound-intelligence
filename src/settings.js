import { Router } from "express";
import { z } from "zod";
import { db } from "./db.js";
import { env } from "./env.js";
import { sha } from "./rules.js";
import { getActiveProfile, audit } from "./pipeline.js";

export const settings = Router();

const err = (res, status, code, message) => res.status(status).json({ error: { code, message } });
const wrap = (fn) => async (req, res) => {
  try { await fn(req, res); } catch (e) { console.error(e); err(res, 500, "server_error", "Something went wrong: " + e.message); }
};

const list = (max, each) =>
  z.array(z.string().trim().max(each)).max(max).transform((a) => [...new Set(a.map((x) => x.trim()).filter(Boolean))]);

const profileSchema = z.object({
  company_name: z.string().trim().min(1, "Enter your company name").max(120),
  signature_name: z.string().trim().max(120),
  signature_title: z.string().trim().max(120),
  category: z.string().trim().min(2, "Describe what you sell").max(200),
  capabilities: list(20, 200),
  value_props: list(10, 400),
  personas: list(15, 100).refine((a) => a.length >= 1, "Add at least one target persona"),
  approved_claims: list(40, 400).refine((a) => a.length >= 1, "Add at least one approved claim"),
  banned_claims: list(40, 200),
  tone_style: z.string().trim().max(300),
}).strict();

const view = (p) => ({
  version: p.version,
  company_name: p.product?.company_name ?? "",
  signature_name: p.product?.signature?.name ?? "",
  signature_title: p.product?.signature?.title ?? "",
  category: p.product?.category ?? "",
  capabilities: p.product?.capabilities ?? [],
  value_props: p.value_props ?? [],
  personas: p.personas ?? [],
  approved_claims: p.approved_claims ?? [],
  banned_claims: p.banned_claims ?? [],
  tone_style: p.tone_rules?.style ?? "",
});

settings.get("/profile", wrap(async (req, res) => {
  res.json({ profile: view(await getActiveProfile()) });
}));

settings.put("/profile", wrap(async (req, res) => {
  const body = profileSchema.safeParse(req.body);
  if (!body.success) return err(res, 400, "invalid_input", body.error.issues.map((i) => i.message).join(". "));
  const v = body.data;
  const cur = await getActiveProfile();
  const next = {
    product: { ...cur.product, company_name: v.company_name, category: v.category, capabilities: v.capabilities, signature: { name: v.signature_name, title: v.signature_title } },
    value_props: v.value_props, personas: v.personas, approved_claims: v.approved_claims, banned_claims: v.banned_claims,
    tone_rules: { ...cur.tone_rules, style: v.tone_style },
  };
  const same = (a, b) => sha(view({ ...a, version: 0 })) === sha(view({ ...b, version: 0 }));
  if (same(cur, next)) return res.json({ ok: true, unchanged: true, version: cur.version });

  await db.from("seller_profiles").update({ is_active: false }).eq("id", cur.id);
  const ins = await db.from("seller_profiles").insert({ version: cur.version + 1, is_active: true, icp: cur.icp, ...next }).select().single();
  if (ins.error) {
    await db.from("seller_profiles").update({ is_active: true }).eq("id", cur.id);
    return err(res, 500, "db_error", ins.error.message);
  }
  await audit(null, "profile_updated", { from: cur.version, to: ins.data.version });
  res.json({ ok: true, version: ins.data.version });
}));

settings.get("/preflight", wrap(async (req, res) => {
  const today = new Date().toISOString().slice(0, 10);
  const monthStart = new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), 1)).toISOString();
  const prof = await db.from("seller_profiles").select("version, product").eq("is_active", true).maybeSingle();
  const quota = await db.from("gemini_quota").select("used, cap").eq("day", today).maybeSingle();
  const search = await db.from("gemini_calls").select("id", { count: "exact", head: true }).eq("model", "tavily-search").gte("created_at", monthStart);
  const cred = await db.from("gmail_credentials").select("email").eq("id", 1).maybeSingle();
  const gmailConfigured = !!(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET && env.GOOGLE_REDIRECT_URI && env.TOKEN_ENCRYPTION_KEY);
  res.json({
    database: { ok: !prof.error && !!prof.data, message: prof.error ? prof.error.message : "Connected" },
    profile: { ok: !!prof.data?.product?.company_name, version: prof.data?.version ?? null, message: prof.data?.product?.company_name ? "Company name is set" : "Add your company name in the Seller profile" },
    gemini: { ok: !!env.GEMINI_API_KEY, model: env.GEMINI_MODEL, used: quota.data?.used ?? 0, cap: quota.data?.cap ?? env.GEMINI_DAILY_CAP },
    search: { ok: !!env.TAVILY_API_KEY, used: search.count ?? 0, cap: 1000 },
    gmail: { ok: gmailConfigured && !!cred.data, configured: gmailConfigured, connected: !!cred.data, email: cred.data?.email ?? null },
  });
}));

settings.get("/runs", wrap(async (req, res) => {
  const { data: runs } = await db.from("runs").select("*").order("started_at", { ascending: false }).limit(25);
  if (!runs?.length) return res.json({ runs: [] });
  const pros = (await db.from("prospects").select("id, full_name, company_claimed").in("id", [...new Set(runs.map((r) => r.prospect_id))])).data ?? [];
  const byId = new Map(pros.map((p) => [p.id, p]));
  const ev = (await db.from("run_events").select("run_id, payload").eq("type", "stage_finished").in("run_id", runs.map((r) => r.id))).data ?? [];
  const stats = new Map();
  for (const e of ev) {
    const s = stats.get(e.run_id) ?? { stages: 0, reused: 0 };
    s.stages++;
    if (String(e.payload?.outcome ?? "").startsWith("skipped")) s.reused++;
    stats.set(e.run_id, s);
  }
  res.json({
    runs: runs.map((r) => ({
      id: r.id, prospect_id: r.prospect_id, status: r.status, trigger: r.trigger, started_at: r.started_at,
      duration_ms: r.finished_at ? new Date(r.finished_at) - new Date(r.started_at) : null,
      needs_input_reason: r.needs_input_reason, error: r.error?.message ?? null,
      prospect: byId.get(r.prospect_id) ?? null, stages: stats.get(r.id)?.stages ?? 0, reused: stats.get(r.id)?.reused ?? 0,
    })),
  });
}));
