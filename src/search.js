import { env } from "./env.js";
import { db } from "./db.js";

export class SearchError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

async function post(body) {
  const res = await fetch("https://api.tavily.com/search", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${env.TAVILY_API_KEY}` },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(20000),
  });
  const json = await res.json().catch(() => ({}));
  return { res, json };
}

export async function tavilySearch({ prospectId, stage, query, topic = "general", maxResults = 6, timeRange = null, includeDomains = null }) {
  const started = Date.now();
  const body = { query, topic, search_depth: "basic", max_results: maxResults, include_answer: false };
  if (timeRange) body.time_range = timeRange;
  if (includeDomains) body.include_domains = includeDomains;
  let results = [];
  let failure = null;

  try {
    let { res, json } = await post(body);
    if (res.status === 400 && body.time_range) {
      // Some accounts or versions reject time_range; retry once without it.
      delete body.time_range;
      ({ res, json } = await post(body));
    }
    if (!res.ok) {
      const quota = [429, 432, 433].includes(res.status);
      throw new SearchError(
        quota ? "search_quota" : "search_failed",
        quota
          ? "The free Tavily search allowance is used up for this month."
          : `Search failed (${res.status}): ${JSON.stringify(json?.detail ?? json).slice(0, 200)}`
      );
    }
    results = (json.results ?? []).map((r) => ({
      title: r.title ?? "",
      url: r.url ?? "",
      content: r.content ?? "",
      published_date: r.published_date ?? null,
    }));
  } catch (e) {
    failure = e instanceof SearchError ? e : new SearchError("search_failed", String(e?.message ?? e));
  }

  const { data } = await db
    .from("gemini_calls")
    .insert({
      prospect_id: prospectId,
      stage,
      call_type: "grounded",
      model: "tavily-search",
      prompt_version: "tavily-v1",
      request_payload: body,
      rendered_prompt: query,
      response: JSON.stringify(results).slice(0, 100000),
      grounding_metadata: { results },
      latency_ms: Date.now() - started,
      attempt: 1,
      error: failure ? { code: failure.code, message: failure.message } : null,
    })
    .select("id")
    .single();

  if (failure) throw failure;
  return { results, callId: data?.id ?? null };
}
