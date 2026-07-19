/**
 * Resolves Google Generative AI model ids dynamically via the ListModels API.
 * Caches results to avoid repeated lookups during orchestration.
 */

type GoogleModelTier = "pro" | "flash";

interface GoogleModelRecord {
  readonly name?: string;
  readonly supportedGenerationMethods?: readonly string[];
}

interface GoogleListModelsResponse {
  readonly models?: readonly GoogleModelRecord[];
}

const GOOGLE_LIST_MODELS_URL = "https://generativelanguage.googleapis.com/v1beta/models";

const DEFAULT_FALLBACK_BY_TIER: Readonly<Record<GoogleModelTier, string>> = {
  pro: "gemini-1.5-pro-latest",
  flash: "gemini-1.5-flash-latest",
};

const CACHE_TTL_MS = 60 * 60 * 1000;

let cachedModelIds: readonly string[] | null = null;
let cacheExpiresAtMs = 0;
let inflightListRequest: Promise<readonly string[]> | null = null;

export function getGoogleGenerativeAiApiKey(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const fromGoogleEnv = env.GOOGLE_GENERATIVE_AI_API_KEY?.trim();
  if (fromGoogleEnv) {
    return fromGoogleEnv;
  }
  return env.GEMINI_API_KEY?.trim() || undefined;
}

function stripModelsPrefix(name: string): string {
  return name.startsWith("models/") ? name.slice("models/".length) : name;
}

function inferTier(preferredModelId: string): GoogleModelTier {
  return preferredModelId.toLowerCase().includes("flash") ? "flash" : "pro";
}

function supportsGenerateContent(model: GoogleModelRecord): boolean {
  return model.supportedGenerationMethods?.includes("generateContent") ?? false;
}

function scoreModelMatch(modelId: string, preferredModelId: string): number {
  const id = modelId.toLowerCase();
  const preferred = preferredModelId.toLowerCase();
  const preferredBase = preferred.replace(/-latest$/, "");

  if (id === preferred) {
    return 1_000;
  }
  if (id === `${preferredBase}-latest`) {
    return 950;
  }
  if (id.startsWith(`${preferredBase}-`) || id.startsWith(preferredBase)) {
    return 900 - id.length;
  }
  if (id.includes(preferredBase)) {
    return 700;
  }
  return 0;
}

function pickBestPreferredMatch(models: readonly string[], preferredModelId: string): string | null {
  let best: { readonly id: string; readonly score: number } | null = null;
  for (const modelId of models) {
    const score = scoreModelMatch(modelId, preferredModelId);
    if (score > 0 && (best === null || score > best.score)) {
      best = { id: modelId, score };
    }
  }
  return best?.id ?? null;
}

function pickLatestGeminiTier(models: readonly string[], tier: GoogleModelTier): string | null {
  const candidates = models.filter((modelId) => {
    const lower = modelId.toLowerCase();
    if (!lower.includes("gemini")) {
      return false;
    }
    if (tier === "flash") {
      return lower.includes("flash");
    }
    return lower.includes("pro") && !lower.includes("flash");
  });

  const latestSuffix = candidates.find((modelId) => modelId.toLowerCase().endsWith("-latest"));
  if (latestSuffix) {
    return latestSuffix;
  }

  const sorted = [...candidates].sort((a, b) => b.localeCompare(a));
  return sorted[0] ?? null;
}

async function fetchGenerateContentModels(apiKey: string): Promise<readonly string[]> {
  const url = `${GOOGLE_LIST_MODELS_URL}?key=${encodeURIComponent(apiKey)}`;
  const response = await fetch(url, {
    method: "GET",
    headers: { Accept: "application/json" },
  });

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`Google ListModels failed (${response.status}): ${body.slice(0, 300)}`);
  }

  const payload = (await response.json()) as GoogleListModelsResponse;
  const models = payload.models ?? [];

  return models
    .filter(supportsGenerateContent)
    .map((model) => stripModelsPrefix(model.name ?? ""))
    .filter((modelId) => modelId.length > 0);
}

async function loadGenerateContentModels(): Promise<readonly string[]> {
  const apiKey = getGoogleGenerativeAiApiKey();
  if (!apiKey) {
    console.warn("[googleModelResolver] No GOOGLE_GENERATIVE_AI_API_KEY/GEMINI_API_KEY — using static fallbacks.");
    return [];
  }

  try {
    return await fetchGenerateContentModels(apiKey);
  } catch (err) {
    const rawMessage = err instanceof Error ? err.message : String(err);
    const message = rawMessage.replaceAll(apiKey, "[REDACTED]");
    console.warn(`[googleModelResolver] ListModels request failed — using static fallbacks: ${message}`);
    return [];
  }
}

async function getCachedGenerateContentModels(): Promise<readonly string[]> {
  const now = Date.now();
  if (cachedModelIds !== null && now < cacheExpiresAtMs) {
    return cachedModelIds;
  }

  if (inflightListRequest) {
    return inflightListRequest;
  }

  inflightListRequest = loadGenerateContentModels()
    .then((models) => {
      cachedModelIds = models;
      cacheExpiresAtMs = Date.now() + CACHE_TTL_MS;
      if (models.length > 0) {
        console.log(`[googleModelResolver] Cached ${models.length} generateContent-capable Google models.`);
      }
      return models;
    })
    .finally(() => {
      inflightListRequest = null;
    });

  return inflightListRequest;
}

/** Preloads model list during server startup (non-fatal on failure). */
export async function warmGoogleModelResolverCache(): Promise<void> {
  await getCachedGenerateContentModels();
}

export function resetGoogleModelResolverCacheForTests(): void {
  cachedModelIds = null;
  cacheExpiresAtMs = 0;
  inflightListRequest = null;
}

/**
 * Resolves a configured Google model preference to an API-supported model id.
 * Falls back to gemini-1.5-pro-latest / gemini-1.5-flash-latest when ListModels fails.
 */
export async function resolveGoogleModelId(preferredModelId: string): Promise<string> {
  const tier = inferTier(preferredModelId);
  const fallback = DEFAULT_FALLBACK_BY_TIER[tier];

  const models = await getCachedGenerateContentModels();
  if (models.length === 0) {
    return fallback;
  }

  const preferredMatch = pickBestPreferredMatch(models, preferredModelId);
  if (preferredMatch) {
    return preferredMatch;
  }

  const tierMatch = pickLatestGeminiTier(models, tier);
  if (tierMatch) {
    return tierMatch;
  }

  return fallback;
}
