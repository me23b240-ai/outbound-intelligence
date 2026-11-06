import { Router } from "express";
import { z } from "zod";
import { db } from "./db.js";
import { normalizedFields } from "./prospects.js";

export const imports = Router();

const MAX_ROWS = 300;

const rowSchema = z.object({
  full_name: z.string().trim().min(2, "name is too short").max(200),
  company: z.string().trim().min(2, "company is too short").max(200),
  designation: z.string().trim().max(200).optional(),
  email: z.string().trim().email("email is not valid").optional(),
  linkedin_url: z.string().trim().url("LinkedIn URL is not valid").optional(),
});

const bodySchema = z.object({
  filename: z.string().trim().min(1).max(200),
  rows: z.array(z.record(z.string(), z.unknown())).min(1).max(MAX_ROWS),
});

const cell = (v) => {
  if (v === null || v === undefined) return undefined;
  const s = String(v).trim();
  return s === "" ? undefined : s;
};

imports.get("/template", (req, res) => {
  const csv = [
    "full_name,company,designation,email,linkedin_url",
    "Jane Example,Acme Foods,VP Finance,jane@example.com,",
    "Rahul Sample,Globex India,Head of Finance Operations,,https://www.linkedin.com/in/rahul-sample",
  ].join("\r\n") + "\r\n";
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", 'attachment; filename="prospects-template.csv"');
  res.send(csv);
});

imports.post("/", async (req, res) => {
  const body = bodySchema.safeParse(req.body);
  if (!body.success) {
    return res.status(400).json({
      error: { code: "invalid_input", message: `Send between 1 and ${MAX_ROWS} rows per import.` },
    });
  }
  const { filename, rows } = body.data;

  const { data: existing, error: exErr } = await db
    .from("prospects")
    .select("dedupe_key, email_normalized")
    .is("archived_at", null);
  if (exErr) return res.status(500).json({ error: { code: "db_error", message: exErr.message } });
  const keys = new Set(existing.map((r) => r.dedupe_key));
  const emails = new Set(existing.map((r) => r.email_normalized).filter(Boolean));

  const report = [];
  const accepted = [];
  rows.forEach((raw, i) => {
    const rowNo = i + 2; // spreadsheet row, counting the header as row 1
    const parsed = rowSchema.safeParse({
      full_name: cell(raw.full_name), company: cell(raw.company), designation: cell(raw.designation),
      email: cell(raw.email), linkedin_url: cell(raw.linkedin_url),
    });
    const label = cell(raw.full_name) ?? "(no name)";
    if (!parsed.success) {
      report.push({ row: rowNo, name: label, status: "invalid", reason: parsed.error.issues.map((x) => x.message).join("; ") });
      return;
    }
    const p = parsed.data;
    const n = normalizedFields(p);
    if (keys.has(n.dedupe_key) || (n.email_normalized && emails.has(n.email_normalized))) {
      report.push({ row: rowNo, name: p.full_name, status: "duplicate", reason: "Already in your list, or repeated in this file" });
      return;
    }
    keys.add(n.dedupe_key);
    if (n.email_normalized) emails.add(n.email_normalized);
    accepted.push({ rowNo, record: {
      full_name: p.full_name, company_claimed: p.company, designation: p.designation ?? null,
      email: p.email ?? null, linkedin_url: p.linkedin_url ?? null, ...n, source: "csv",
    } });
    report.push({ row: rowNo, name: p.full_name, status: "accepted", reason: "" });
  });

  const { data: imp, error: impErr } = await db
    .from("imports")
    .insert({ filename, accepted: 0, duplicates: 0, invalid: 0 })
    .select()
    .single();
  if (impErr) return res.status(500).json({ error: { code: "db_error", message: impErr.message } });

  // One bulk insert; if a race trips a unique rule, fall back to row by row so one clash cannot lose the rest.
  let inserted = 0;
  if (accepted.length) {
    const withImport = accepted.map((a) => ({ ...a.record, import_id: imp.id }));
    const bulk = await db.from("prospects").insert(withImport);
    if (!bulk.error) inserted = withImport.length;
    else {
      for (const a of accepted) {
        const one = await db.from("prospects").insert({ ...a.record, import_id: imp.id });
        if (!one.error) inserted++;
        else {
          const r = report.find((x) => x.row === a.rowNo);
          r.status = "duplicate";
          r.reason = "Already in your list";
        }
      }
    }
  }

  const summary = {
    accepted: report.filter((r) => r.status === "accepted").length,
    duplicates: report.filter((r) => r.status === "duplicate").length,
    invalid: report.filter((r) => r.status === "invalid").length,
  };
  await db.from("imports").update({ ...summary, row_report: report }).eq("id", imp.id);
  res.status(201).json({ import: { id: imp.id, filename, ...summary, inserted }, report });
});
