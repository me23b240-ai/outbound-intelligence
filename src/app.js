import express from "express";
import { db } from "./db.js";
import { requireAuth, originCheck, login, logout } from "./auth.js";
import { prospects } from "./prospects.js";

const app = express();
app.use(express.json());
app.use(originCheck);
app.use(express.static("public"));

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

app.post("/api/login", login);
app.post("/api/logout", logout);
app.get("/api/me", requireAuth, (req, res) => res.json({ ok: true }));

app.use("/api/prospects", requireAuth, prospects);

app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: { code: "server_error", message: "Something went wrong" } });
});

export default app;
