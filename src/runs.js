import { Router } from "express";
import { z } from "zod";
import { db } from "./db.js";
import { env } from "./env.js";
import { config } from "./config.js";
import { startRun, runInBackground, RunConflict, getActiveProfile } from "./pipeline.js";

export const runs = Router();

const err = (res, status, code, message) => res.status(status).json({ error: { code, message } });

const bodySchema = z
  .object({
    trigger: z.enum(["manual", "reverify", "regenerate", "fallback"]).default("manual"),
    persona: z.string().trim().max(100).optional(),
  })
  .strict();

runs.post("/prospects/:id/run", async (req, res) => {
  const id = z.string().uuid().safeParse(req.params.id);
  const body = bodySchema.safeParse(req.body ?? {});
  if (!id.success || !body.success) return err(res, 400, "invalid_input", "Bad request");
  if (!env.GEMINI_API_KEY || !env.TAVILY_API_KEY) {
    return err(res, 503, "not_configured", "GEMINI_API_KEY and TAVILY_API_KEY must both be set in .env");
  }
  const { data: prospect } = await db.from("prospects").select("id").eq("id", id.data).is("archived_at", null).maybeSingle();
  if (!prospect) return err(res, 404, "not_found", "Prospect not found");

  const { trigger, persona } = body.data;
  let params = {};
  if (trigger === "fallback") {
    const profile = await getActiveProfile();
    if (!persona || !profile.personas.includes(persona)) return err(res, 400, "invalid_input", "Choose a persona from the list");
    params = { persona };
  }
  if (trigger === "regenerate") params = { regenerate: true };
  if (trigger === "reverify") params = { reverify: true };

  try {
    const run = await startRun(id.data, trigger, params);
    runInBackground(run.id);
    res.status(202).json({ run });
  } catch (e) {
    if (e instanceof RunConflict) return err(res, 409, "run_in_progress", e.message);
    console.error(e);
    err(res, 500, "server_error", "Could not start the run");
  }
});

runs.get("/runs/:id", async (req, res) => {
  const id = z.string().uuid().safeParse(req.params.id);
  if (!id.success) return err(res, 400, "invalid_input", "Bad run id");
  const after = Number(req.query.after) || 0;
  const { data: run } = await db.from("runs").select("*").eq("id", id.data).maybeSingle();
  if (!run) return err(res, 404, "not_found", "Run not found");
  const { data: events } = await db.from("run_events").select("*").eq("run_id", id.data).gt("id", after).order("id").limit(200);
  const stale =
    run.status === "running" && Date.now() - new Date(run.heartbeat_at).getTime() > config.runStaleSeconds * 1000;
  res.json({ run: { ...run, stale }, events: events ?? [] });
});
