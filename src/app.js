import express from "express";
import { db } from "./db.js";
import { requireAuth, originCheck, login, logout } from "./auth.js";
import { prospects } from "./prospects.js";
import { verifyRoute } from "./verify.js";
import { runs } from "./runs.js";
import { review } from "./review.js";
import { imports } from "./imports.js";
import { gmail } from "./gmail.js";
import { settings } from "./settings.js";
import { linkedin } from "./linkedin.js";

const app = express();
app.use(express.json({ limit: "1mb" }));
app.use(originCheck);
app.use(express.static("public"));

app.get("/api/healthz", (req, res) => res.json({ ok: true }));

app.get("/api/db-check", async (req, res) => {
  const { data, error } = await db.from("seller_profiles").select("version").eq("is_active", true).single();
  if (error) return res.status(500).json({ ok: false, error: error.message });
  res.json({ ok: true, profile_version: data.version });
});

app.post("/api/login", login);
app.post("/api/logout", logout);
app.get("/api/me", requireAuth, (req, res) => res.json({ ok: true }));

app.post("/api/prospects/:id/verify", requireAuth, verifyRoute);
app.use("/api/prospects", requireAuth, prospects);
app.use("/api/imports", requireAuth, imports);
app.use("/api", requireAuth, runs);
app.use("/api", requireAuth, review);
app.use("/api", requireAuth, gmail);
app.use("/api", requireAuth, settings);
app.use("/api", requireAuth, linkedin);

app.use("/api", (req, res) => res.status(404).json({ error: { code: "not_found", message: "Not found" } }));

app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: { code: "server_error", message: "Something went wrong" } });
});

export default app;
