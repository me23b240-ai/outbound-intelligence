import crypto from "node:crypto";
import { Router } from "express";
import { z } from "zod";
import { db } from "./db.js";
import { env } from "./env.js";
import { loadState, gateFor, refreshStatus, audit, bump } from "./pipeline.js";

export const gmail = Router();

// The narrowest Google permission that can create drafts. The app only ever calls drafts.create; it never sends.
const SCOPE = "https://www.googleapis.com/auth/gmail.compose";

const err = (res, status, code, message, extra = {}) => res.status(status).json({ error: { code, message, ...extra } });
const configured = () => !!(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET && env.GOOGLE_REDIRECT_URI && env.TOKEN_ENCRYPTION_KEY);

class GmailError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}

/* ---------- encryption of the saved refresh token (AES-256-GCM) ---------- */

function key() {
  const k = Buffer.from(env.TOKEN_ENCRYPTION_KEY ?? "", "base64");
  if (k.length !== 32) throw new GmailError("bad_key", "TOKEN_ENCRYPTION_KEY must be 32 random bytes, base64 encoded.");
  return k;
}

export function encrypt(text) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv("aes-256-gcm", key(), iv);
  const enc = Buffer.concat([c.update(text, "utf8"), c.final()]);
  return [iv, c.getAuthTag(), enc].map((b) => b.toString("base64")).join(".");
}

export function decrypt(packed) {
  const [iv, tag, enc] = String(packed).split(".").map((x) => Buffer.from(x, "base64"));
  const d = crypto.createDecipheriv("aes-256-gcm", key(), iv);
  d.setAuthTag(tag);
  return Buffer.concat([d.update(enc), d.final()]).toString("utf8");
}

/* ---------- the email message ---------- */

const oneLine = (s) => String(s ?? "").replace(/[\r\n]+/g, " ").trim();

export function buildRfc822({ to, subject, body, messageId, draftId }) {
  const subj = oneLine(subject);
  const encSubject = /^[\x20-\x7E]*$/.test(subj) ? subj : `=?UTF-8?B?${Buffer.from(subj, "utf8").toString("base64")}?=`;
  const headers = [
    to ? `To: ${oneLine(to)}` : null,
    `Subject: ${encSubject}`,
    `Message-ID: ${messageId}`,
    `X-Outbound-Draft-Id: ${draftId}`,
    "MIME-Version: 1.0",
    "Content-Type: text/plain; charset=UTF-8",
    "Content-Transfer-Encoding: base64",
  ].filter(Boolean);
  const payload = Buffer.from(String(body).replace(/\r?\n/g, "\r\n"), "utf8").toString("base64").replace(/(.{76})/g, "$1\r\n");
  return headers.join("\r\n") + "\r\n\r\n" + payload;
}

const messageIdFor = (draftId) => `<draft-${draftId}@outbound-intelligence.local>`;

/* ---------- Google OAuth ---------- */

const sign = (v) => crypto.createHmac("sha256", env.SESSION_SECRET).update("gmail-oauth:" + v).digest("base64url");

function makeState() {
  const p = Buffer.from(JSON.stringify({ n: crypto.randomBytes(8).toString("hex"), exp: Date.now() + 10 * 60 * 1000 })).toString("base64url");
  return p + "." + sign(p);
}

function stateOk(s) {
  const [p, sig] = String(s ?? "").split(".");
  if (!p || !sig) return false;
  const a = Buffer.from(sig);
  const b = Buffer.from(sign(p));
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return false;
  try { return JSON.parse(Buffer.from(p, "base64url").toString()).exp > Date.now(); } catch { return false; }
}

async function tokenRequest(params) {
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: env.GOOGLE_CLIENT_ID, client_secret: env.GOOGLE_CLIENT_SECRET, ...params }),
    signal: AbortSignal.timeout(20000),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new GmailError(json.error === "invalid_grant" ? "gmail_reconnect" : "gmail_token", json.error_description || json.error || `Google returned ${res.status}`);
  return json;
}

async function credentials() {
  const { data, error } = await db.from("gmail_credentials").select("*").eq("id", 1).maybeSingle();
  if (error) throw new Error(error.message);
  return data;
}

async function accessToken(cred) {
  const tok = await tokenRequest({ grant_type: "refresh_token", refresh_token: decrypt(cred.refresh_token_enc) });
  return tok.access_token;
}

gmail.get("/gmail/status", async (req, res) => {
  try {
    const cred = configured() ? await credentials() : null;
    res.json({ configured: configured(), connected: !!cred, email: cred?.email ?? null });
  } catch (e) { err(res, 500, "server_error", e.message); }
});

gmail.get("/gmail/connect", (req, res) => {
  if (!configured()) return res.redirect("/?gmail=not_configured");
  const q = new URLSearchParams({
    client_id: env.GOOGLE_CLIENT_ID, redirect_uri: env.GOOGLE_REDIRECT_URI, response_type: "code",
    scope: SCOPE, access_type: "offline", prompt: "consent", state: makeState(),
  });
  res.redirect("https://accounts.google.com/o/oauth2/v2/auth?" + q);
});

gmail.get("/gmail/callback", async (req, res) => {
  if (!configured()) return res.redirect("/?gmail=not_configured");
  if (req.query.error) return res.redirect("/?gmail=denied");
  if (!stateOk(req.query.state)) return res.redirect("/?gmail=bad_state");
  try {
    const tok = await tokenRequest({ grant_type: "authorization_code", code: String(req.query.code ?? ""), redirect_uri: env.GOOGLE_REDIRECT_URI });
    if (!tok.refresh_token) return res.redirect("/?gmail=no_refresh_token");
    const prof = await fetch("https://gmail.googleapis.com/gmail/v1/users/me/profile", {
      headers: { Authorization: `Bearer ${tok.access_token}` }, signal: AbortSignal.timeout(20000),
    }).then((r) => r.json()).catch(() => ({}));
    await db.from("gmail_credentials").delete().eq("id", 1);
    const { error } = await db.from("gmail_credentials").insert({
      id: 1, email: prof.emailAddress ?? null, refresh_token_enc: encrypt(tok.refresh_token), scope: tok.scope ?? SCOPE,
    });
    if (error) throw new Error(error.message);
    await audit(null, "gmail_connected", { email: prof.emailAddress ?? null });
    res.redirect("/?gmail=connected");
  } catch (e) {
    console.error("gmail callback failed:", e);
    res.redirect("/?gmail=failed");
  }
});

gmail.post("/gmail/disconnect", async (req, res) => {
  try {
    const cred = await credentials();
    if (cred && configured()) {
      try {
        await fetch("https://oauth2.googleapis.com/revoke?token=" + encodeURIComponent(decrypt(cred.refresh_token_enc)), { method: "POST", signal: AbortSignal.timeout(10000) });
      } catch { /* best effort */ }
    }
    await db.from("gmail_credentials").delete().eq("id", 1);
    await audit(null, "gmail_disconnected", {});
    res.json({ ok: true });
  } catch (e) { err(res, 500, "server_error", e.message); }
});

/* ---------- creating the draft ---------- */

async function findExisting(token, messageId) {
  try {
    const q = encodeURIComponent(`rfc822msgid:${messageId.replace(/[<>]/g, "")}`);
    const r = await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/drafts?q=${q}&maxResults=5`, {
      headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(15000),
    });
    if (!r.ok) return null;
    const j = await r.json();
    const hit = j.drafts?.[0];
    return hit ? { id: hit.id, messageId: hit.message?.id ?? null, threadId: hit.message?.threadId ?? null } : null;
  } catch { return null; }
}

async function finish(draft, found, toEmail) {
  await db.from("gmail_drafts").update({
    status: "created", gmail_draft_id: found.id, gmail_message_id: found.messageId, gmail_thread_id: found.threadId, error: null, updated_at: new Date().toISOString(),
  }).eq("draft_id", draft.id);
  await db.from("drafts").update({ status: "gmail_draft" }).eq("id", draft.id);
  await audit(draft.prospect_id, "gmail_draft_created", { draft_id: draft.id, gmail_draft_id: found.id, to: toEmail ?? null });
  await bump(draft.prospect_id);
  await refreshStatus(draft.prospect_id);
}

gmail.post("/drafts/:id/gmail", async (req, res) => {
  try {
    const id = z.string().uuid().safeParse(req.params.id);
    const body = z.object({ force: z.boolean().optional() }).strict().safeParse(req.body ?? {});
    if (!id.success || !body.success) return err(res, 400, "invalid_input", "Bad request");
    if (!configured()) return err(res, 503, "gmail_not_configured", "Gmail is not set up in .env yet.");

    const { data: draft } = await db.from("drafts").select("*").eq("id", id.data).maybeSingle();
    if (!draft) return err(res, 404, "not_found", "Draft not found");
    if (draft.status === "gmail_draft") return res.json({ ok: true, already: true });

    const { data: latestRows } = await db.from("drafts").select("id").eq("prospect_id", draft.prospect_id).eq("lane", draft.lane).order("version", { ascending: false }).limit(1);
    if (latestRows?.[0]?.id !== draft.id) return err(res, 409, "not_latest", "Only the newest version can be saved to Gmail.");

    const state = await loadState(draft.prospect_id);
    const gate = await gateFor(draft, state, "approved");
    if (!gate.allowed) return err(res, 409, "gate_blocked", "This draft is no longer safe to save. Approve it again after fixing the issue.", { reasons: gate.reasons });

    const cred = await credentials();
    if (!cred) return err(res, 409, "gmail_not_connected", "Connect Gmail first.");

    let token;
    try { token = await accessToken(cred); }
    catch (e) {
      if (e.code === "gmail_reconnect") return err(res, 409, "gmail_reconnect", "Google no longer accepts the saved connection. This happens after 7 days in test mode. Disconnect and connect Gmail again.");
      throw e;
    }

    const msgId = messageIdFor(draft.id);
    const toEmail = state.prospect.email ?? null;
    let row = (await db.from("gmail_drafts").select("*").eq("draft_id", draft.id).maybeSingle()).data;

    if (row?.status === "created") { await finish(draft, { id: row.gmail_draft_id, messageId: row.gmail_message_id, threadId: row.gmail_thread_id }, row.to_email); return res.json({ ok: true, already: true }); }

    if (row && ["creating", "unknown"].includes(row.status)) {
      const found = await findExisting(token, msgId);
      if (found) { await finish(draft, found, toEmail); return res.json({ ok: true, recovered: true }); }
      if (!body.data.force) {
        return err(res, 409, "gmail_unknown", "An earlier attempt may or may not have saved a draft. Check your Gmail Drafts folder. If it is not there, press Create anyway.");
      }
    }

    if (!row) {
      const ins = await db.from("gmail_drafts").insert({ draft_id: draft.id, prospect_id: draft.prospect_id, status: "creating", to_email: toEmail, message_id_header: msgId }).select().single();
      if (ins.error) {
        if (ins.error.code === "23505") return err(res, 409, "in_progress", "This draft is already being saved. Wait a moment.");
        throw new Error(ins.error.message);
      }
      row = ins.data;
    } else {
      await db.from("gmail_drafts").update({ status: "creating", attempts: (row.attempts ?? 1) + 1, error: null, updated_at: new Date().toISOString() }).eq("draft_id", draft.id);
    }

    const raw = Buffer.from(buildRfc822({ to: toEmail, subject: draft.subject, body: draft.body, messageId: msgId, draftId: draft.id })).toString("base64url");
    let r;
    try {
      r = await fetch("https://gmail.googleapis.com/gmail/v1/users/me/drafts", {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ message: { raw } }),
        signal: AbortSignal.timeout(20000),
      });
    } catch (e) {
      // The request may have reached Google, so we cannot say it failed. Mark it unknown and let the user check.
      await db.from("gmail_drafts").update({ status: "unknown", error: { message: String(e.message).slice(0, 300) }, updated_at: new Date().toISOString() }).eq("draft_id", draft.id);
      return err(res, 502, "gmail_unknown", "Could not tell whether Google saved the draft. Check your Gmail Drafts folder before trying again.");
    }
    const json = await r.json().catch(() => ({}));
    if (r.ok && json.id) {
      await finish(draft, { id: json.id, messageId: json.message?.id ?? null, threadId: json.message?.threadId ?? null }, toEmail);
      return res.json({ ok: true });
    }
    const message = json.error?.message ?? `Google returned ${r.status}`;
    if (r.status >= 500) {
      await db.from("gmail_drafts").update({ status: "unknown", error: { status: r.status, message }, updated_at: new Date().toISOString() }).eq("draft_id", draft.id);
      return err(res, 502, "gmail_unknown", "Google had a problem and may or may not have saved the draft. Check your Gmail Drafts folder before trying again.");
    }
    await db.from("gmail_drafts").update({ status: "failed", error: { status: r.status, message }, updated_at: new Date().toISOString() }).eq("draft_id", draft.id);
    const auth = r.status === 401 || r.status === 403;
    return err(res, 502, auth ? "gmail_auth" : "gmail_failed", auth ? "Google refused the request. Disconnect and connect Gmail again." : `Google could not save the draft: ${message}`);
  } catch (e) {
    console.error("gmail draft failed:", e);
    err(res, 500, "server_error", "Something went wrong: " + e.message);
  }
});
