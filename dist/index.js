import { buildJsonPluginConfigSchema, definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";

/**
 * DeepSeek Search provider for OpenClaw's managed `web_search` tool.
 *
 * Upstream API: `POST https://api.deepseek.com/v1/tools/search`
 * Auth: `Authorization: Bearer <DEEPSEEK_API_KEY>`
 * Docs: https://api-docs.deepseek.com/guides/search.md
 *
 * The plugin is intentionally dependency-free apart from `definePluginEntry` so
 * that a host upgrade can only break the documented public entry point.
 */

const PLUGIN_ID = "deepseek-search";
const PROVIDER_ID = "deepseek-search";
const PLUGIN_NAME = "DeepSeek Search";
const PLUGIN_DESCRIPTION = "DeepSeek native web search provider";

const DEFAULT_BASE_URL = "https://api.deepseek.com";
const SEARCH_PATH = "/v1/tools/search";
const CREDENTIAL_PATH = `plugins.entries.${PLUGIN_ID}.config.webSearch.apiKey`;
const ENV_VARS = ["DEEPSEEK_API_KEY"];

const DEFAULT_COUNT = 10;
const MAX_COUNT = 50;
const DEFAULT_TIMEOUT_SECONDS = 30;
const DEFAULT_CACHE_TTL_MINUTES = 15;
const MAX_CACHE_ENTRIES = 200;
const MAX_CONTENT_CHARS = 2000;

const CONFIG_SCHEMA_JSON = {
  type: "object",
  additionalProperties: false,
  properties: {
    webSearch: {
      type: "object",
      additionalProperties: false,
      properties: {
        apiKey: {
          type: ["string", "object"],
          description: "DeepSeek API key, or a SecretRef object.",
        },
        baseUrl: { type: "string", description: "Defaults to https://api.deepseek.com." },
        maxResults: { type: "integer", minimum: 1, maximum: 50 },
        needContent: { type: "boolean" },
        localization: { type: "string" },
        timeoutSeconds: { type: "number", minimum: 1, maximum: 300 },
        cacheTtlMinutes: { type: "number", minimum: 0 },
      },
    },
  },
};

// ---------------------------------------------------------------------------
// small helpers
// ---------------------------------------------------------------------------

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asRecord(value) {
  return isRecord(value) ? value : undefined;
}

function nonEmptyString(value) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

/**
 * Accepts a plain string or an OpenClaw SecretRef object
 * (`{ source: "env" | "file" | "exec", id: "ENV_OR_FILE_ID" }`).
 */
function resolveSecretString(value) {
  const direct = nonEmptyString(value);
  if (direct) return direct;
  const ref = asRecord(value);
  if (!ref) return undefined;
  const id = nonEmptyString(ref.id);
  if (!id) return undefined;
  if (ref.source === "env" || ref.source === undefined) {
    return nonEmptyString(process.env[id]);
  }
  return undefined;
}

function resolveEnvValue(envVars) {
  for (const name of envVars) {
    const value = nonEmptyString(process.env[name]);
    if (value) return value;
  }
  return undefined;
}

function clampInteger(value, min, max) {
  const parsed = typeof value === "number" ? value : Number.parseInt(String(value ?? ""), 10);
  if (!Number.isFinite(parsed)) return undefined;
  return Math.min(max, Math.max(min, Math.trunc(parsed)));
}

function clampNumber(value, min, max) {
  const parsed = typeof value === "number" ? value : Number.parseFloat(String(value ?? ""));
  if (!Number.isFinite(parsed)) return undefined;
  return Math.min(max, Math.max(min, parsed));
}

function readBooleanParam(args, ...keys) {
  for (const key of keys) {
    const value = args?.[key];
    if (typeof value === "boolean") return value;
    if (typeof value === "string") {
      const normalized = value.trim().toLowerCase();
      if (normalized === "true") return true;
      if (normalized === "false") return false;
    }
  }
  return undefined;
}

function readStringParam(args, ...keys) {
  for (const key of keys) {
    const value = nonEmptyString(args?.[key]);
    if (value) return value;
  }
  return undefined;
}

function hostnameOf(url) {
  try {
    return new URL(url).hostname || undefined;
  } catch {
    return undefined;
  }
}

function truncate(text, maxChars) {
  if (typeof text !== "string") return "";
  const trimmed = text.trim();
  if (trimmed.length <= maxChars) return trimmed;
  return `${trimmed.slice(0, maxChars).trimEnd()}…`;
}

// ---------------------------------------------------------------------------
// config resolution
// ---------------------------------------------------------------------------

/**
 * `ctx.searchConfig` is the global `tools.web.search` config; the provider's own
 * settings live under `plugins.entries.<plugin>.config.webSearch`.
 */
function resolveProviderConfig(config, searchConfig) {
  const entry = asRecord(asRecord(asRecord(config?.plugins)?.entries)?.[PLUGIN_ID]);
  const pluginWebSearch = asRecord(asRecord(entry?.config)?.webSearch);
  const global = asRecord(searchConfig) ?? {};

  return {
    baseUrl: normalizeBaseUrl(
      nonEmptyString(pluginWebSearch?.baseUrl) ??
        nonEmptyString(global.baseUrl) ??
        DEFAULT_BASE_URL,
    ),
    apiKey:
      resolveSecretString(pluginWebSearch?.apiKey) ??
      resolveSecretString(global.apiKey) ??
      resolveEnvValue(ENV_VARS),
    maxResults:
      clampInteger(pluginWebSearch?.maxResults, 1, MAX_COUNT) ??
      clampInteger(global.maxResults, 1, MAX_COUNT),
    needContent:
      (typeof pluginWebSearch?.needContent === "boolean" ? pluginWebSearch.needContent : undefined) ??
      (typeof global.needContent === "boolean" ? global.needContent : undefined) ??
      false,
    localization: nonEmptyString(pluginWebSearch?.localization) ?? nonEmptyString(global.localization),
    timeoutSeconds:
      clampNumber(pluginWebSearch?.timeoutSeconds, 1, 300) ??
      clampNumber(global.timeoutSeconds, 1, 300) ??
      DEFAULT_TIMEOUT_SECONDS,
    cacheTtlMinutes:
      clampNumber(pluginWebSearch?.cacheTtlMinutes, 0, 24 * 60) ??
      clampNumber(global.cacheTtlMinutes, 0, 24 * 60) ??
      DEFAULT_CACHE_TTL_MINUTES,
  };
}

function normalizeBaseUrl(value) {
  const raw = nonEmptyString(value) ?? DEFAULT_BASE_URL;
  return raw.replace(/\/+$/, "");
}

// ---------------------------------------------------------------------------
// in-memory search cache (cost guard: $0.75 / 1000 successful requests)
// ---------------------------------------------------------------------------

const searchCache = new Map();

function readCachedPayload(key, ttlMs) {
  if (!(ttlMs > 0)) return undefined;
  const entry = searchCache.get(key);
  if (!entry) return undefined;
  if (entry.expiresAt <= Date.now()) {
    searchCache.delete(key);
    return undefined;
  }
  return { ...entry.payload, cached: true };
}

function writeCachedPayload(key, payload, ttlMs) {
  if (!(ttlMs > 0)) return;
  while (searchCache.size >= MAX_CACHE_ENTRIES) {
    const oldest = searchCache.keys().next();
    if (oldest.done) break;
    searchCache.delete(oldest.value);
  }
  searchCache.set(key, { payload, expiresAt: Date.now() + ttlMs });
}

// ---------------------------------------------------------------------------
// upstream call
// ---------------------------------------------------------------------------

function buildTimeoutSignal(parentSignal, timeoutSeconds) {
  const timeoutMs = Math.round(Math.max(1, timeoutSeconds) * 1000);
  let timeoutSignal;
  try {
    timeoutSignal = AbortSignal.timeout(timeoutMs);
  } catch {
    timeoutSignal = undefined;
  }
  if (!parentSignal) return timeoutSignal;
  if (!timeoutSignal) return parentSignal;
  try {
    return AbortSignal.any([parentSignal, timeoutSignal]);
  } catch {
    return parentSignal;
  }
}

async function requestDeepSeekSearch({ config, query, count, needContent, oriQuestion, signal }) {
  const url = `${config.baseUrl}${SEARCH_PATH}`;
  const body = { query, count };
  if (oriQuestion) body.ori_question = oriQuestion;
  if (config.localization) body.localization = config.localization;
  if (needContent) body.need_content = true;

  const response = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${config.apiKey}`,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify(body),
    signal: buildTimeoutSignal(signal, config.timeoutSeconds),
  });

  if (!response.ok) {
    // Never echo the upstream body: it can reflect request credentials.
    throw new Error(`DeepSeek Search API error (HTTP ${response.status})`);
  }

  let data;
  try {
    data = await response.json();
  } catch {
    throw new Error("DeepSeek Search API returned a non-JSON response.");
  }
  return data;
}

function mapResults(data, count, needContent) {
  const raw = Array.isArray(data?.results) ? data.results : [];
  const results = [];
  for (const entry of raw.slice(0, count)) {
    const url = nonEmptyString(entry?.url);
    if (!url) continue;
    const title = typeof entry?.title === "string" ? entry.title : "";
    const summary = typeof entry?.summary === "string" ? entry.summary : "";
    const snippetText = typeof entry?.snippet === "string" ? entry.snippet : "";
    const contentText = typeof entry?.content === "string" ? entry.content : "";

    let snippet = snippetText || summary;
    if (needContent && contentText) {
      const extra = truncate(contentText, MAX_CONTENT_CHARS);
      snippet = snippet ? `${snippet}\n\n${extra}` : extra;
    }

    results.push({
      title,
      url,
      // `description` is what the bundled providers emit; `snippet` is the
      // normalized field. Emit both so either boundary path resolves.
      description: snippet,
      snippet,
      siteName: hostnameOf(url),
    });
  }
  return results;
}

// ---------------------------------------------------------------------------
// payloads
// ---------------------------------------------------------------------------

function missingApiKeyPayload() {
  return {
    error: "missing_deepseek_api_key",
    message:
      "web_search (deepseek-search) needs a DeepSeek API key. Set " +
      `\`${CREDENTIAL_PATH}\` to your key, or set DEEPSEEK_API_KEY in the Gateway environment.`,
    docs: "https://docs.openclaw.ai/tools/web",
  };
}

// ---------------------------------------------------------------------------
// provider
// ---------------------------------------------------------------------------

const SearchParameters = {
  type: "object",
  properties: {
    query: {
      type: "string",
      description: "Search query string (1-128 characters).",
    },
    count: {
      type: "integer",
      description: `Number of results to return (1-${MAX_COUNT}).`,
      minimum: 1,
      maximum: MAX_COUNT,
    },
    need_content: {
      type: "boolean",
      description: "Fetch and include page body text for each result (slower, larger).",
    },
    ori_question: {
      type: "string",
      description: "Original user question, used to improve query understanding.",
    },
  },
  required: ["query"],
  additionalProperties: false,
};

function createDeepSeekSearchProvider() {
  return {
    id: PROVIDER_ID,
    label: PLUGIN_NAME,
    hint: "DeepSeek native search API (api.deepseek.com/v1/tools/search)",
    onboardingScopes: ["text-inference"],
    credentialLabel: "DeepSeek API key",
    envVars: [...ENV_VARS],
    placeholder: "sk-...",
    signupUrl: "https://platform.deepseek.com/api_keys",
    docsUrl: "https://api-docs.deepseek.com/guides/search.md",
    // Deliberately late: DeepSeek should win only when pinned explicitly or
    // when no earlier keyed provider is configured.
    autoDetectOrder: 210,
    credentialPath: CREDENTIAL_PATH,
    inactiveSecretPaths: [CREDENTIAL_PATH],
    getCredentialValue: (searchConfig) => asRecord(searchConfig)?.apiKey,
    setCredentialValue: (searchConfigTarget, value) => {
      const target = asRecord(searchConfigTarget);
      if (target) target.apiKey = value;
    },
    getConfiguredCredentialValue: (config) =>
      asRecord(asRecord(asRecord(asRecord(config?.plugins)?.entries)?.[PLUGIN_ID])?.config)?.webSearch
        ?.apiKey,
    setConfiguredCredentialValue: (configTarget, value) => {
      const root = asRecord(configTarget);
      if (!root) return;
      root.plugins ??= {};
      root.plugins.entries ??= {};
      root.plugins.entries[PLUGIN_ID] ??= {};
      const entry = root.plugins.entries[PLUGIN_ID];
      if (entry.enabled === undefined) entry.enabled = true;
      entry.config ??= {};
      entry.config.webSearch ??= {};
      entry.config.webSearch.apiKey = value;
    },
    createTool: (ctx) => ({
      description:
        "Search the web with DeepSeek Search. Returns titles, URLs, snippets, and site names.",
      parameters: SearchParameters,
      execute: async (args, context) => {
        context?.signal?.throwIfAborted();

        const config = resolveProviderConfig(ctx?.config, ctx?.searchConfig);
        if (!config.apiKey) return missingApiKeyPayload();

        const query = readStringParam(args, "query", "q");
        if (!query) throw new Error("web_search (deepseek-search) requires a non-empty `query`.");
        if (query.length > 128) {
          throw new Error("web_search (deepseek-search): `query` must be 128 characters or fewer.");
        }

        const count = clampInteger(args?.count, 1, MAX_COUNT) ?? config.maxResults ?? DEFAULT_COUNT;
        const needContent = readBooleanParam(args, "need_content", "needContent") ?? config.needContent;
        const oriQuestion = readStringParam(args, "ori_question", "oriQuestion");

        const cacheKey = JSON.stringify([
          PROVIDER_ID,
          config.baseUrl,
          query,
          count,
          needContent,
          config.localization ?? "",
          oriQuestion ?? "",
        ]);
        const ttlMs = config.cacheTtlMinutes * 60_000;
        const cached = readCachedPayload(cacheKey, ttlMs);
        if (cached) return cached;

        const startedAt = Date.now();
        const data = await requestDeepSeekSearch({
          config,
          query,
          count,
          needContent,
          oriQuestion,
          signal: context?.signal,
        });
        context?.signal?.throwIfAborted();

        const results = mapResults(data, count, needContent);
        const payload = {
          query,
          provider: PROVIDER_ID,
          count: results.length,
          tookMs: Date.now() - startedAt,
          externalContent: {
            untrusted: true,
            source: "web_search",
            provider: PROVIDER_ID,
            wrapped: true,
          },
          results,
        };
        writeCachedPayload(cacheKey, payload, ttlMs);
        return payload;
      },
    }),
  };
}

export default definePluginEntry({
  id: PLUGIN_ID,
  name: PLUGIN_NAME,
  description: PLUGIN_DESCRIPTION,
  configSchema: buildJsonPluginConfigSchema(CONFIG_SCHEMA_JSON),
  register(api) {
    api.registerWebSearchProvider(createDeepSeekSearchProvider());
  },
});
