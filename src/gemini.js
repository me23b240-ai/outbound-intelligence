import { GoogleGenAI } from "@google/genai";
import { z } from "zod";
import { env } from "./env.js";
import { db } from "./db.js";

const MAX_ATTEMPTS = 3;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export class GeminiError extends Error {
  constructor(code, message, cause) {
    super(message);
    this.code = code;
    this.cause = cause;
  }
}

// Throw this from a validate callback to ask the model for one corrected answer.
export class ValidationFailure extends Error {}

function isQuota(e) {
  return Number(e?.status) === 429 || /exceeded your current quota|resource has been exhausted/i.test(String(e?.message));
}

function isRetryable(e) {
  const status = Number(e?.status ?? e?.code);
  if ([429, 500, 502, 503, 504].includes(status)) return true;
  return /fetch failed|timeout|ETIMEDOUT|ECONNRESET|overloaded|unavailable|exceeded your current quota|resource has been exhausted/i.test(
    String(e?.message)
  );
}

async function logCall(row) {
  const { data, error } = await db.from("gemini_calls").insert(row).select("id").single();
  if (error) {
    console.error("gemini_calls insert failed:", error.message);
    return null;
  }
  return data.id;
}

async function reserveCall() {
  const day = new Date().toISOString().slice(0, 10);
  const { data, error } = await db.rpc("reserve_gemini_call", { p_day: day, p_cap: env.GEMINI_DAILY_CAP });
  if (error) throw new GeminiError("quota_error", error.message);
  if (!data) throw new GeminiError("quota_exhausted", "The daily Gemini call limit has been reached");
}

// Keeps us under the free tier's per-minute limit while one process runs a pipeline.
let lastCallAt = 0;
async function pace() {
  const wait = lastCallAt + env.GEMINI_MIN_GAP_MS - Date.now();
  if (wait > 0) await sleep(wait);
  lastCallAt = Date.now();
}

export async function callModel({ prospectId, stage, promptVersion, requestPayload, prompt }) {
  const ai = new GoogleGenAI({ apiKey: env.GEMINI_API_KEY });
  const config = { responseMimeType: "application/json", temperature: 0.1 };

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    await reserveCall();
    await pace();
    const started = Date.now();
    const base = {
      prospect_id: prospectId,
      stage,
      call_type: "structured",
      model: env.GEMINI_MODEL,
      prompt_version: promptVersion,
      request_payload: requestPayload,
      rendered_prompt: prompt,
      attempt,
    };
    try {
      const response = await ai.models.generateContent({ model: env.GEMINI_MODEL, contents: prompt, config });
      const text = response.text ?? "";
      const usage = response.usageMetadata ?? {};
      const callId = await logCall({
        ...base,
        response: text,
        input_tokens: usage.promptTokenCount ?? null,
        output_tokens: usage.candidatesTokenCount ?? null,
        latency_ms: Date.now() - started,
        error: text.trim() ? null : { code: "empty_response" },
      });
      if (!text.trim()) throw new GeminiError("empty_response", "The model returned an empty response");
      return { text, callId };
    } catch (e) {
      if (e instanceof GeminiError) throw e;
      await logCall({
        ...base,
        latency_ms: Date.now() - started,
        error: { message: String(e?.message ?? e).slice(0, 500), status: e?.status ?? null },
      });
      if (attempt < MAX_ATTEMPTS && isRetryable(e)) {
        await sleep(isQuota(e) ? 20000 : 1000 * 2 ** attempt);
        continue;
      }
      if (isQuota(e)) {
        throw new GeminiError(
          "provider_quota",
          "Google reports no quota left for this API key right now. Wait a minute, or check your daily limit.",
          e
        );
      }
      throw new GeminiError("gemini_failed", String(e?.message ?? e).slice(0, 300), e);
    }
  }
  throw new GeminiError("gemini_failed", "Gemini did not respond after retries");
}

// One model call that must return JSON matching `schema` (and pass `validate`, if given).
// A bad answer gets exactly one repair attempt that quotes what was wrong.
export async function structuredCall({ schema, prompt, validate, ...meta }) {
  let nextPrompt = prompt;
  let lastDetail = "unknown problem";
  for (let i = 0; i < 2; i++) {
    const r = await callModel({
      ...meta,
      prompt: nextPrompt,
      requestPayload: { ...meta.requestPayload, repair: i === 1 },
    });
    try {
      const cleaned = r.text.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "").trim();
      const data = schema.parse(JSON.parse(cleaned));
      if (validate) validate(data);
      return { data, callId: r.callId };
    } catch (e) {
      lastDetail =
        e instanceof z.ZodError
          ? e.issues.map((x) => `${x.path.join(".")}: ${x.message}`).join("; ")
          : e instanceof ValidationFailure
            ? e.message
            : "not valid JSON";
      nextPrompt = `${prompt}\n\nYour previous reply was rejected (${lastDetail}). Return only the corrected JSON.`;
    }
  }
  throw new GeminiError("invalid_output", `The model output failed validation after one repair attempt: ${lastDetail}`);
}
