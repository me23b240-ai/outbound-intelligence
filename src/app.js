import express from "express";

const app = express();
app.use(express.json());

app.get("/api/healthz", (req, res) => res.json({ ok: true }));

export default app;
