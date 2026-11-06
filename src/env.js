import "dotenv/config";
import { z } from "zod";

const schema = z.object({
  SUPABASE_URL: z.string().url(),
  SUPABASE_SERVICE_KEY: z.string().min(20),
  GEMINI_API_KEY: z.string().optional(),
  GEMINI_MODEL: z.string().default("gemini-3.5-flash-lite"),
  GEMINI_DAILY_CAP: z.coerce.number().default(450),
  GEMINI_MIN_GAP_MS: z.coerce.number().default(4200),
  TAVILY_API_KEY: z.string().optional(),
  DEMO_PASSWORD: z.string().min(6),
  SESSION_SECRET: z.string().min(16),
  APP_ORIGIN: z.string().default("http://localhost:3000"),
  INTERNAL_SECRET: z.string().optional(),
  GOOGLE_CLIENT_ID: z.string().optional(),
  GOOGLE_CLIENT_SECRET: z.string().optional(),
  GOOGLE_REDIRECT_URI: z.string().optional(),
  TOKEN_ENCRYPTION_KEY: z.string().optional(),
});

const result = schema.safeParse(process.env);
if (!result.success) {
  const lines = result.error.issues.map((i) => `  ${i.path.join(".")}: ${i.message}`);
  throw new Error("Bad or missing environment variables:\n" + lines.join("\n"));
}

export const env = result.data;
