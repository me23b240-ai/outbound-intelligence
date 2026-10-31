import "dotenv/config";
import { z } from "zod";

const schema = z.object({
  SUPABASE_URL: z.string().url(),
  SUPABASE_SERVICE_KEY: z.string().min(20),
  GEMINI_API_KEY: z.string().optional(),
  GEMINI_DAILY_CAP: z.coerce.number().default(200),
  DEMO_PASSWORD: z.string().optional(),
  SESSION_SECRET: z.string().optional(),
  APP_ORIGIN: z.string().default("http://localhost:3000"),
  INTERNAL_SECRET: z.string().optional(),
  ADVANCE_BUDGET_MS: z.coerce.number().default(40000),
  MIN_STAGE_MS: z.coerce.number().default(8000),
  MAX_RESUMES: z.coerce.number().default(5),
});

const result = schema.safeParse(process.env);
if (!result.success) {
  const lines = result.error.issues.map((i) => `  ${i.path.join(".")}: ${i.message}`);
  throw new Error("Bad or missing environment variables:\n" + lines.join("\n"));
}

export const env = result.data;
