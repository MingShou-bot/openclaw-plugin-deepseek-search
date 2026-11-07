/**
 * Offline contract harness for the deepseek-search plugin.
 *
 * Exercises the plugin exactly the way OpenClaw's web-search runtime does
 * (`createTool({ config, agentDir, searchConfig, runtimeMetadata })` then
 * `execute(args, { signal })`), against a local HTTP server that mimics the
 * DeepSeek Search API. No API key and no network egress required.
 *
 * Run: node tests/harness.mjs
 */
import assert from "node:assert/strict";
import http from "node:http";

const pluginModule = await import("../dist/index.js");
const plugin = pluginModule.default;

if (process.env.HARNESS_DEBUG) {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    console.error(`    [fetch] ${url}`);
    try {
      const response = await originalFetch(url, init);
      console.error(`    [fetch] <- ${response.status}`);
      return response;
    } catch (error) {
      console.error(`    [fetch] <- ERR ${error.name}`);
      throw error;
    }
  };
}

const PLUGIN_ID = "deepseek-search";
const PROVIDER_ID = "deepseek-search";
const CREDENTIAL_PATH = `plugins.entries.${PLUGIN_ID}.config.webSearch.apiKey`;

let passed = 0;
const failures = [];

async function test(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`  ok   ${name}`);
  } catch (error) {
    failures.push({ name, error });
    console.log(`  FAIL ${name}\n         ${error?.message ?? error}`);
  }
}

// ---------------------------------------------------------------------------
// mock upstream
// ---------------------------------------------------------------------------

function startServer(handler) {
  const server = http.createServer(handler);
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      resolve({ server, baseUrl: `http://127.0.0.1:${port}` });
    });
  });
}

function readBody(req) {
  return new Promise((resolve) => {
    let raw = "";
    req.on("data", (chunk) => {
      raw += chunk;
    });
    req.on("end", () => {
      let parsed;
      try {
        parsed = JSON.parse(raw);
      } catch {
        parsed = raw;
      }
      resolve(parsed);
    });
  });
}

function collect(captured) {
  return async (req, res) => {
    const body = await readBody(req);
    captured.push({ url: req.url, method: req.method, headers: req.headers, body });
    if (process.env.HARNESS_DEBUG) {
      console.error(`    [mock :${req.socket.localPort}] ${req.method} ${req.url} count=${body?.count}`);
    }
    await captured.respond(req, res, body, captured.length);
  };
}

async function withServer(responder, fn) {
  const captured = [];
  captured.respond = responder;
  const { server, baseUrl } = await startServer(collect(captured));
  try {
    return await fn({ captured, baseUrl });
  } finally {
    if (process.env.HARNESS_DEBUG) {
      console.error(`    [withServer] base=${baseUrl} requests=${captured.length}`);
    }
    await new Promise((resolve) => server.close(resolve));
  }
}

function jsonResponse(res, status, payload) {
  const text = JSON.stringify(payload);
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(text);
}

function deepSeekPayload(results) {
  return { results };
}

// ---------------------------------------------------------------------------
// config helpers
// ---------------------------------------------------------------------------

function buildConfig({ baseUrl, apiKey, pluginConfig, globalSearch } = {}) {
  const config = { plugins: { entries: {} } };
  const webSearch = { ...(pluginConfig ?? {}) };
  if (apiKey !== undefined) webSearch.apiKey = apiKey;
  if (baseUrl !== undefined) webSearch.baseUrl = baseUrl;
  const entry = {};
  if (Object.keys(webSearch).length > 0) entry.config = { webSearch };
  if (Object.keys(entry).length > 0) config.plugins.entries[PLUGIN_ID] = entry;
  if (process.env.HARNESS_DEBUG) {
    console.error(`    [buildConfig] ${JSON.stringify(config)}`);
  }
  return { config, searchConfig: globalSearch ?? {} };
}

function buildTool({ config, searchConfig }) {
  const api = {
    registerWebSearchProvider(provider) {
      api.provider = provider;
    },
  };
  plugin.register(api);
  assert.ok(api.provider, "register() did not call api.registerWebSearchProvider");
  const tool = api.provider.createTool({
    config,
    agentDir: "C:\\tmp\\agent",
    searchConfig,
    runtimeMetadata: undefined,
  });
  assert.ok(tool && typeof tool.execute === "function", "createTool() returned no execute()");
  return { provider: api.provider, tool };
}

function withKeyEnv(value) {
  const previous = process.env.DEEPSEEK_API_KEY;
  if (value === undefined) delete process.env.DEEPSEEK_API_KEY;
  else process.env.DEEPSEEK_API_KEY = value;
  return () => {
    if (previous === undefined) delete process.env.DEEPSEEK_API_KEY;
    else process.env.DEEPSEEK_API_KEY = previous;
  };
}

// ---------------------------------------------------------------------------
// tests
// ---------------------------------------------------------------------------

console.log("deepseek-search plugin harness\n");

await test("plugin entry exposes the expected identity", () => {
  assert.equal(plugin.id, PLUGIN_ID);
  assert.equal(plugin.name, "DeepSeek Search");
  assert.equal(typeof plugin.register, "function");
  assert.equal(typeof plugin.configSchema?.safeParse, "function");
  assert.equal(plugin.configSchema.jsonSchema.properties.webSearch.type, "object");
  assert.equal(plugin.configSchema.safeParse({ webSearch: { apiKey: "sk-x" } }).success, true);
  assert.equal(plugin.configSchema.safeParse({ nope: 1 }).success, false);
});

await test("provider declares every required web-search contract field", () => {
  const restore = withKeyEnv(undefined);
  const { provider } = buildTool(buildConfig());
  try {
    for (const field of [
      "id",
      "label",
      "hint",
      "envVars",
      "placeholder",
      "signupUrl",
      "credentialPath",
      "getCredentialValue",
      "setCredentialValue",
      "createTool",
    ]) {
      assert.ok(provider[field] !== undefined, `provider.${field} is missing`);
    }
    assert.equal(provider.id, PROVIDER_ID);
    assert.equal(provider.credentialPath, CREDENTIAL_PATH);
    assert.ok(provider.autoDetectOrder >= 100, "autoDetectOrder should not outrank keyed providers");
    assert.equal(provider.getCredentialValue({ apiKey: "sk-from-config" }), "sk-from-config");
    const target = {};
    provider.setCredentialValue(target, "sk-new");
    assert.equal(target.apiKey, "sk-new");
    assert.equal(
      provider.getConfiguredCredentialValue({ plugins: { entries: { [PLUGIN_ID]: { config: { webSearch: { apiKey: "sk-a" } } } } } }),
      "sk-a",
    );
    const configTarget = {};
    provider.setConfiguredCredentialValue(configTarget, "sk-b");
    assert.equal(configTarget.plugins.entries[PLUGIN_ID].config.webSearch.apiKey, "sk-b");
    assert.equal(configTarget.plugins.entries[PLUGIN_ID].enabled, true);
  } finally {
    restore();
  }
});

await test("search request shape and result mapping", async () => {
  const restore = withKeyEnv(undefined);
  try {
    await withServer(
      async (req, res) => {
        jsonResponse(
          res,
          200,
          deepSeekPayload([
            {
              rerank_score: 2.4,
              title: "DeepSeek 官方文档",
              url: "https://api-docs.deepseek.com/guides/search",
              snippet: "搜索 API 使用 /v1/tools/search。",
              summary: "summary text",
            },
            {
              rerank_score: 1.1,
              title: "Second result",
              url: "https://example.com/a?b=1",
              snippet: "second snippet",
            },
            { title: "no url result", snippet: "skipped" },
          ]),
        );
      },
      async ({ captured, baseUrl }) => {
        const { tool } = buildTool(buildConfig({ apiKey: "sk-test-key", baseUrl }));
        const payload = await tool.execute({ query: "DeepSeek 搜索 API" });

        assert.equal(captured.length, 1);
        const request = captured[0];
        assert.equal(request.method, "POST");
        assert.equal(request.url, "/v1/tools/search");
        assert.equal(request.headers.authorization, "Bearer sk-test-key");
        assert.equal(request.headers["content-type"], "application/json");
        assert.deepEqual(request.body, { query: "DeepSeek 搜索 API", count: 10 });

        assert.equal(payload.provider, PROVIDER_ID);
        assert.equal(payload.query, "DeepSeek 搜索 API");
        assert.equal(payload.count, 2, "results without a url must be dropped");
        assert.ok(Number.isInteger(payload.tookMs));
        assert.deepEqual(payload.externalContent, {
          untrusted: true,
          source: "web_search",
          provider: PROVIDER_ID,
          wrapped: true,
        });
        assert.equal(payload.results[0].title, "DeepSeek 官方文档");
        assert.equal(payload.results[0].url, "https://api-docs.deepseek.com/guides/search");
        assert.equal(payload.results[0].snippet, "搜索 API 使用 /v1/tools/search。");
        assert.equal(payload.results[0].description, payload.results[0].snippet);
        assert.equal(payload.results[0].siteName, "api-docs.deepseek.com");
        assert.equal(payload.results[1].snippet, "second snippet");
        assert.equal(payload.results[1].siteName, "example.com");
      },
    );
  } finally {
    restore();
  }
});

await test("query operators are forwarded verbatim", async () => {
  const restore = withKeyEnv("sk-env");
  try {
    const queries = ['site:docs.deepseek.com search', '-site:zhihu.com "deepseek" lang:zh after:2026-01-01'];
    let index = 0;
    await withServer(
      async (req, res) => {
        jsonResponse(res, 200, deepSeekPayload([]));
      },
      async ({ captured, baseUrl }) => {
        const { tool } = buildTool(buildConfig({ pluginConfig: { apiKey: "sk-x", baseUrl } }));
        for (const query of queries) {
          await tool.execute({ query });
          index += 1;
        }
        assert.equal(captured.length, queries.length);
        queries.forEach((query, i) => assert.equal(captured[i].body.query, query));
      },
    );
    assert.equal(index, 2);
  } finally {
    restore();
  }
});

await test("count is clamped to 1..50 and honours plugin maxResults", async () => {
  const restore = withKeyEnv(undefined);
  try {
    await withServer(
      async (req, res) => {
        jsonResponse(res, 200, deepSeekPayload([]));
      },
      async ({ captured, baseUrl }) => {
        const { tool } = buildTool(buildConfig({ pluginConfig: { apiKey: "sk-x", baseUrl } }));
        await tool.execute({ query: "clamp-high", count: 99 });
        await tool.execute({ query: "clamp-low", count: 0 });
        await tool.execute({ query: "clamp-default" });
        assert.equal(captured[0].body.count, 50);
        assert.equal(captured[1].body.count, 1);
        assert.equal(captured[2].body.count, 10);

        const { tool: tool2 } = buildTool(
          buildConfig({ pluginConfig: { apiKey: "sk-x", baseUrl, maxResults: 3 } }),
        );
        await tool2.execute({ query: "clamp-config-default" });
        assert.equal(captured[3].body.count, 3);
      },
    );
  } finally {
    restore();
  }
});

await test("need_content is opt-in and folds page text into the snippet", async () => {
  const restore = withKeyEnv(undefined);
  try {
    await withServer(
      async (req, res) => {
        jsonResponse(
          res,
          200,
          deepSeekPayload([
            { title: "T", url: "https://example.com/p", snippet: "short", content: "x".repeat(50) },
          ]),
        );
      },
      async ({ captured, baseUrl }) => {
        const { tool } = buildTool(buildConfig({ pluginConfig: { apiKey: "sk-x", baseUrl } }));
        const plain = await tool.execute({ query: "need-content-off" });
        assert.equal(captured[0].body.need_content, undefined);
        assert.equal(plain.results[0].snippet, "short");

        const rich = await tool.execute({ query: "need-content-on", need_content: true });
        assert.equal(captured[1].body.need_content, true);
        assert.ok(rich.results[0].snippet.startsWith("short"));
        assert.ok(rich.results[0].snippet.includes("xxxxxxxxxx"));
      },
    );
  } finally {
    restore();
  }
});

await test("ori_question and localization are forwarded when configured", async () => {
  const restore = withKeyEnv(undefined);
  try {
    await withServer(
      async (req, res) => {
        jsonResponse(res, 200, deepSeekPayload([]));
      },
      async ({ captured, baseUrl }) => {
        const { tool } = buildTool(
          buildConfig({ pluginConfig: { apiKey: "sk-x", baseUrl, localization: "1.2.3.4" } }),
        );
        await tool.execute({ query: "q", ori_question: "原始问题？" });
        assert.equal(captured[0].body.ori_question, "原始问题？");
        assert.equal(captured[0].body.localization, "1.2.3.4");
      },
    );
  } finally {
    restore();
  }
});

await test("missing credential returns the structured availability payload", async () => {
  const restore = withKeyEnv(undefined);
  try {
    const { tool } = buildTool(buildConfig({}));
    const payload = await tool.execute({ query: "no key" });
    assert.equal(payload.error, "missing_deepseek_api_key");
    assert.match(payload.error, /^missing_[a-z0-9_]*api_key$/i, "core matches this regex for fallback");
    assert.equal(typeof payload.message, "string");
    assert.equal(typeof payload.docs, "string");
  } finally {
    restore();
  }
});

await test("env var and SecretRef credentials are resolved", async () => {
  for (const [label, value] of [
    ["DEEPSEEK_API_KEY env", "sk-from-env"],
    ["SecretRef to env", { source: "env", id: "DEEPSEEK_API_KEY" }],
  ]) {
    const restore = withKeyEnv("sk-from-env");
    try {
      await withServer(
        async (req, res) => {
          jsonResponse(res, 200, deepSeekPayload([]));
        },
        async ({ captured, baseUrl }) => {
          const { tool } = buildTool(buildConfig({ pluginConfig: { apiKey: value, baseUrl } }));
          await tool.execute({ query: `credential-${label}` });
          assert.equal(captured[0].headers.authorization, "Bearer sk-from-env", label);
        },
      );
    } finally {
      restore();
    }
  }
});

await test("upstream HTTP failure surfaces status without leaking the key", async () => {
  const restore = withKeyEnv(undefined);
  try {
    await withServer(
      async (req, res) => {
        res.writeHead(401, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: { message: "invalid key sk-secret-xyz" } }));
      },
      async ({ baseUrl }) => {
        const { tool } = buildTool(buildConfig({ apiKey: "sk-secret-xyz", baseUrl }));
        await assert.rejects(
          () => tool.execute({ query: "http-error" }),
          (error) => {
            assert.match(error.message, /HTTP 401/);
            assert.ok(!error.message.includes("sk-secret-xyz"), "error must not echo the API key");
            return true;
          },
        );
      },
    );
  } finally {
    restore();
  }
});

await test("identical queries are served from the in-memory cache", async () => {
  const restore = withKeyEnv(undefined);
  try {
    await withServer(
      async (req, res) => {
        jsonResponse(res, 200, deepSeekPayload([{ title: "cached", url: "https://example.com/c" }]));
      },
      async ({ captured, baseUrl }) => {
        const { tool } = buildTool(buildConfig({ pluginConfig: { apiKey: "sk-x", baseUrl } }));
        const first = await tool.execute({ query: "cache-me" });
        const second = await tool.execute({ query: "cache-me" });
        assert.equal(captured.length, 1, "second call must not hit the network");
        assert.equal(first.cached, undefined);
        assert.equal(second.cached, true);
        assert.deepEqual(second.results, first.results);
      },
    );
  } finally {
    restore();
  }
});

await test("cacheTtlMinutes: 0 disables caching", async () => {
  const restore = withKeyEnv(undefined);
  try {
    await withServer(
      async (req, res) => {
        jsonResponse(res, 200, deepSeekPayload([]));
      },
      async ({ captured, baseUrl }) => {
        const { tool } = buildTool(
          buildConfig({ pluginConfig: { apiKey: "sk-x", baseUrl, cacheTtlMinutes: 0 } }),
        );
        await tool.execute({ query: "no-cache" });
        await tool.execute({ query: "no-cache" });
        assert.equal(captured.length, 2);
      },
    );
  } finally {
    restore();
  }
});

await test("caller cancellation aborts the request", async () => {
  const restore = withKeyEnv(undefined);
  try {
    await withServer(
      (req, res) => {
        setTimeout(() => {
          try {
            jsonResponse(res, 200, deepSeekPayload([]));
          } catch {
            /* ignore */
          }
        }, 5000);
      },
      async ({ baseUrl }) => {
        const { tool } = buildTool(buildConfig({ pluginConfig: { apiKey: "sk-x", baseUrl } }));
        const controller = new AbortController();
        const pending = tool.execute({ query: "cancel-me" }, { signal: controller.signal });
        setTimeout(() => controller.abort(), 50);
        await assert.rejects(pending, (error) => error.name === "AbortError");
      },
    );
  } finally {
    restore();
  }
});

await test("request timeout aborts through a TimeoutError", async () => {
  const restore = withKeyEnv(undefined);
  try {
    await withServer(
      (req, res) => {
        setTimeout(() => {
          try {
            jsonResponse(res, 200, deepSeekPayload([]));
          } catch {
            /* ignore */
          }
        }, 5000);
      },
      async ({ baseUrl }) => {
        const { tool } = buildTool(
          buildConfig({ pluginConfig: { apiKey: "sk-x", baseUrl, timeoutSeconds: 1 } }),
        );
        await assert.rejects(
          () => tool.execute({ query: "timeout-me" }),
          (error) => error.name === "TimeoutError" || error.name === "AbortError",
        );
      },
    );
  } finally {
    restore();
  }
});

await test("empty result sets and missing result arrays are handled", async () => {
  const restore = withKeyEnv(undefined);
  try {
    let call = 0;
    await withServer(
      async (req, res) => {
        call += 1;
        jsonResponse(res, 200, call === 1 ? { results: [] } : {});
      },
      async ({ baseUrl }) => {
        const { tool } = buildTool(buildConfig({ pluginConfig: { apiKey: "sk-x", baseUrl } }));
        const empty = await tool.execute({ query: "empty-results" });
        assert.equal(empty.count, 0);
        assert.deepEqual(empty.results, []);
        const missing = await tool.execute({ query: "missing-results" });
        assert.equal(missing.count, 0);
      },
    );
  } finally {
    restore();
  }
});

await test("invalid tool input is rejected before any network call", async () => {
  const restore = withKeyEnv(undefined);
  try {
    await withServer(
      async (req, res) => {
        jsonResponse(res, 200, deepSeekPayload([]));
      },
      async ({ captured, baseUrl }) => {
        const { tool } = buildTool(buildConfig({ pluginConfig: { apiKey: "sk-x", baseUrl } }));
        await assert.rejects(() => tool.execute({}), /non-empty `query`/);
        await assert.rejects(() => tool.execute({ query: "x".repeat(129) }), /128 characters/);
        assert.equal(captured.length, 0);
      },
    );
  } finally {
    restore();
  }
});

await test("base URL tolerates a trailing slash and custom hosts", async () => {
  const restore = withKeyEnv(undefined);
  try {
    await withServer(
      async (req, res) => {
        jsonResponse(res, 200, deepSeekPayload([]));
      },
      async ({ captured, baseUrl }) => {
        const { tool } = buildTool(
          buildConfig({ pluginConfig: { apiKey: "sk-x", baseUrl: `${baseUrl}/` } }),
        );
        await tool.execute({ query: "trailing-slash" });
        assert.equal(captured[0].url, "/v1/tools/search");
      },
    );
  } finally {
    restore();
  }
});

await test("tool parameter schema is a usable JSON Schema", () => {
  const restore = withKeyEnv(undefined);
  const { tool } = buildTool(buildConfig({}));
  restore();
  assert.equal(tool.parameters.type, "object");
  assert.deepEqual(tool.parameters.required, ["query"]);
  assert.equal(tool.parameters.properties.query.type, "string");
  assert.equal(tool.parameters.properties.count.maximum, 50);
  assert.equal(tool.parameters.properties.need_content.type, "boolean");
  assert.equal(typeof tool.description, "string");
});

// ---------------------------------------------------------------------------
// boundary compatibility: run the payload through OpenClaw's real normalizer
// ---------------------------------------------------------------------------

async function loadNormalizer() {
  const { readdir } = await import("node:fs/promises");
  const path = await import("node:path");
  const { pathToFileURL } = await import("node:url");

  const packageDirs = [];
  if (process.env.OPENCLAW_CLI) {
    packageDirs.push(path.dirname(path.resolve(process.env.OPENCLAW_CLI)));
  }
  packageDirs.push(path.resolve(import.meta.dirname, "..", "node_modules", "openclaw"));

  for (const packageDir of packageDirs) {
    const distDir = path.join(packageDir, "dist");
    let entries;
    try {
      entries = await readdir(distDir);
    } catch {
      continue;
    }
    const candidate = entries.find((name) => /^web-search-output-.*\.mjs$/.test(name));
    if (!candidate) continue;
    const module = await import(pathToFileURL(path.join(distDir, candidate)).href);
    const normalizer = module.n ?? module.normalizeWebSearchOutput;
    if (typeof normalizer === "function") return normalizer;
  }
  return undefined;
}

await test("payload normalizes to OpenClaw's closed `results` branch", async () => {
  const normalize = await loadNormalizer();
  if (!normalize) {
    console.log("         (skipped: could not locate web-search-output module)");
    return;
  }
  const restore = withKeyEnv(undefined);
  try {
    await withServer(
      async (req, res) => {
        jsonResponse(
          res,
          200,
          deepSeekPayload([
            { title: "A", url: "https://example.com/a", snippet: "alpha" },
            { title: "B", url: "https://example.com/b", summary: "beta summary" },
          ]),
        );
      },
      async ({ baseUrl }) => {
        const { tool } = buildTool(buildConfig({ pluginConfig: { apiKey: "sk-x", baseUrl } }));
        const raw = await tool.execute({ query: "boundary-check" });
        const normalized = normalize({ provider: PROVIDER_ID, query: "boundary-check", result: raw });
        assert.equal(normalized.kind, "results", `expected results branch, got ${normalized.kind}`);
        assert.equal(normalized.provider, PROVIDER_ID);
        assert.equal(normalized.query, "boundary-check");
        assert.equal(normalized.results.length, 2);
        assert.ok(normalized.results[0].title.includes("A"), "title is preserved inside the trust envelope");
        assert.equal(normalized.results[0].url, "https://example.com/a");
        assert.ok(normalized.results[0].snippet.includes("alpha"));
        assert.ok(normalized.results[1].snippet.includes("beta summary"), "summary falls back to snippet");
        assert.deepEqual(normalized.externalContent, {
          untrusted: true,
          source: "web_search",
          wrapped: true,
          provider: PROVIDER_ID,
        });
      },
    );
  } finally {
    restore();
  }
});

await test("missing-key payload normalizes to the closed `error` branch", async () => {
  const normalize = await loadNormalizer();
  if (!normalize) {
    console.log("         (skipped: could not locate web-search-output module)");
    return;
  }
  const restore = withKeyEnv(undefined);
  try {
    const { tool } = buildTool(buildConfig({}));
    const raw = await tool.execute({ query: "no-key-boundary" });
    const normalized = normalize({ provider: PROVIDER_ID, query: "no-key-boundary", result: raw });
    assert.equal(normalized.kind, "error");
    assert.equal(normalized.error, "provider_error");
    assert.match(normalized.message, /missing_deepseek_api_key/);
  } finally {
    restore();
  }
});

// ---------------------------------------------------------------------------

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length > 0) {
  for (const { name, error } of failures) {
    console.error(`\n--- ${name} ---\n${error?.stack ?? error}`);
  }
  process.exit(1);
}
