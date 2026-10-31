import crypto from "node:crypto";
import { env } from "./env.js";

const MAX_AGE = 60 * 60 * 12;

const sign = (v) =>
  crypto.createHmac("sha256", env.SESSION_SECRET).update(v).digest("base64url");

function safeEqual(a, b) {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

function makeToken() {
  const payload = Buffer.from(
    JSON.stringify({ exp: Date.now() + MAX_AGE * 1000 })
  ).toString("base64url");
  return payload + "." + sign(payload);
}

function readCookie(req, name) {
  const raw = req.headers.cookie || "";
  for (const part of raw.split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) return v.join("=");
  }
  return null;
}

function isLoggedIn(req) {
  const token = readCookie(req, "session");
  if (!token) return false;
  const [payload, sig] = token.split(".");
  if (!payload || !sig || !safeEqual(sig, sign(payload))) return false;
  try {
    return JSON.parse(Buffer.from(payload, "base64url").toString()).exp > Date.now();
  } catch {
    return false;
  }
}

const secure = process.env.VERCEL ? "; Secure" : "";

export function requireAuth(req, res, next) {
  if (isLoggedIn(req)) return next();
  res.status(401).json({ error: { code: "unauthorized", message: "Please log in" } });
}

export function originCheck(req, res, next) {
  if (["GET", "HEAD", "OPTIONS"].includes(req.method)) return next();
  const origin = req.headers.origin;
  if (origin && origin !== env.APP_ORIGIN) {
    return res.status(403).json({ error: { code: "bad_origin", message: "Origin not allowed" } });
  }
  next();
}

export function login(req, res) {
  const pw = typeof req.body?.password === "string" ? req.body.password : "";
  if (!safeEqual(pw, env.DEMO_PASSWORD)) {
    return res.status(401).json({ error: { code: "bad_password", message: "Wrong password" } });
  }
  res.setHeader(
    "Set-Cookie",
    `session=${makeToken()}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${MAX_AGE}${secure}`
  );
  res.json({ ok: true });
}

export function logout(req, res) {
  res.setHeader("Set-Cookie", `session=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0${secure}`);
  res.json({ ok: true });
}
