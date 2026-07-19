/**
 * Per-model token pricing ledger (USD per 1M tokens).
 * Used by actors (cost estimation) and fsmEngine (fiscal budget recording).
 */

import type { LlmProvider } from "./types.js";

export interface ModelPricingRates {
  readonly provider: LlmProvider;
  readonly inputPerMillionUsd: number;
  readonly outputPerMillionUsd: number;
}

/** Current illustrative rates — keep in sync with provider billing pages. */
export const MODEL_PRICING_USD: Readonly<Record<string, ModelPricingRates>> = {
  "claude-3-5-sonnet-20241022": { provider: "ANTHROPIC", inputPerMillionUsd: 3.0, outputPerMillionUsd: 15.0 },
  "claude-3-5-haiku-20241022": { provider: "ANTHROPIC", inputPerMillionUsd: 0.8, outputPerMillionUsd: 4.0 },
  "gemini-1.5-pro": { provider: "GOOGLE", inputPerMillionUsd: 1.25, outputPerMillionUsd: 5.0 },
  "gemini-1.5-flash": { provider: "GOOGLE", inputPerMillionUsd: 0.075, outputPerMillionUsd: 0.3 },
};

const FALLBACK_RATES: ModelPricingRates = {
  provider: "GOOGLE",
  inputPerMillionUsd: 1.25,
  outputPerMillionUsd: 5.0,
};

export function getModelPricing(modelId: string): ModelPricingRates {
  return MODEL_PRICING_USD[modelId] ?? FALLBACK_RATES;
}

/** Computes USD cost for a single agent turn from actual token counts and model id. */
export function estimateTurnCostUsd(modelId: string, inputTokens: number, outputTokens: number): number {
  const rates = getModelPricing(modelId);
  return (
    (inputTokens / 1_000_000) * rates.inputPerMillionUsd +
    (outputTokens / 1_000_000) * rates.outputPerMillionUsd
  );
}
