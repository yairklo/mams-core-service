/**
 * Validated environment configuration for the MAMS microservice.
 * At least one LLM provider key must be present; Git credentials are required
 * for workspace initialization.
 */

import { z } from "zod";

export const MamsEnvSchema = z
  .object({
    MAMS_DATABASE_URL: z.string().min(1),
    PORT: z.coerce.number().int().positive().default(8080),
    GEMINI_API_KEY: z.string().optional(),
    ANTHROPIC_API_KEY: z.string().optional(),
    GITHUB_AUTH_TOKEN: z.string().min(1),
    GITHUB_REPO_URL: z.string().url(),
    MAMS_FISCAL_BUDGET_LIMIT_USD: z.coerce.number().positive().default(10),
    MAMS_DEFAULT_DEADLINE_MS: z.coerce.number().int().positive().default(3_600_000),
  })
  .refine(
    (env) => Boolean(env.GEMINI_API_KEY?.trim()) || Boolean(env.ANTHROPIC_API_KEY?.trim()),
    { message: "At least one of GEMINI_API_KEY or ANTHROPIC_API_KEY must be set (non-empty)." }
  );

export type MamsEnv = z.infer<typeof MamsEnvSchema>;

let cachedEnv: MamsEnv | null = null;

export function loadMamsEnv(env: NodeJS.ProcessEnv = process.env): MamsEnv {
  if (cachedEnv) {
    return cachedEnv;
  }
  const parsed = MamsEnvSchema.safeParse(env);
  if (!parsed.success) {
    throw new Error(`Invalid MAMS environment configuration: ${parsed.error.toString()}`);
  }
  cachedEnv = parsed.data;
  return cachedEnv;
}

export function resetMamsEnvCacheForTests(): void {
  cachedEnv = null;
}
