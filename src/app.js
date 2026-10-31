import express from "express";
import { db } from "./db.js";

const app = express();
app.use(express.json());

app.get("/api/healthz", (req, res) => res.json({ ok: true }));

app.get("/api/db-check", async (req, res) => {
  const { data, error } = await db
    .from("seller_profiles")
    .select("version")
    .eq("is_active", true)
    .single();
  if (error) return res.status(500).json({ ok: false, error: error.message });
  res.json({ ok: true, profile_version: data.version });
});

export default app;
