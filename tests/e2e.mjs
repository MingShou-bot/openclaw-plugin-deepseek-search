/**
 * End-to-end test: drives the real `openclaw infer web search` pipeline against
 * a local mock of the DeepSeek Search API, using an isolated state directory.
 *
 * Proves: plugin discovery -> provider selection via `tools.web.search.provider`
 * -> tool construction -> HTTP call -> OpenClaw's result normalization.
 *
 * Requirements:
 *   - an `openclaw` install reachable as `node_modules/openclaw/openclaw.mjs`
 *     (peer/dev dependency), or `OPENCLAW_CLI=/path/to/openclaw.mjs`
 *
 * Run: node tests/e2e.mjs
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const API_KEY = "sk-e2e-mock-key-not-real";

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

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

// ---------------------------------------------------------------------------
// locate an openclaw CLI
// ---------------------------------------------------------------------------

function ancestors(start) {
  const dirs = [];
  let current = start;
  for (;;) {
    dirs.push(current);
    const parent = path.dirname(current);
    if (parent === current) return dirs;
    current = parent;
  }
}

function resolveOpenclawCli() {
  const explicit = process.env.OPENCLAW_CLI?.trim();
  if (explicit && fs.existsSync(explicit)) return explicit;
  for (const dir of ancestors(REPO_ROOT)) {
    const candidate = path.join(dir, "node_modules", "openclaw", "openclaw.mjs");
    if (fs.existsSync(candidate)) return candidate;
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// mock DeepSeek Search API
// ---------------------------------------------------------------------------

const requests = [];

function startMock() {
  const server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => {
      raw += chunk;
    });
    req.on("end", () => {
      let body;
      try {
        body = JSON.parse(raw);
      } catch {
        body = raw;
      }
      requests.push({ url: req.url, method: req.method, headers: req.headers, body });
      if (req.headers.authorization !== `Bearer ${API_KEY}`) {
        res.writeHead(401, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "unauthorized" }));
        return;
      }
      const results = [
        {
          rerank_score: 3.1,
          title: "Example Domain",
          url: "https://example.com/",
          snippet: "This domain is for use in illustrative examples.",
        },
        {
          rerank_score: 2.2,
          title: "DeepSeek 文档",
          url: "https://api-docs.deepseek.com/guides/search",
          snippet: "DeepSeek 搜索 API 指南。",
        },
        {
          rerank_score: 1.3,
          title: "Third hit",
          url: "https://example.org/third",
          snippet: "third snippet",
        },
      ];
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ results }));
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      resolve({ server, port: server.address().port });
    });
  });
}

// ---------------------------------------------------------------------------
// isolated state directory
// ---------------------------------------------------------------------------

function linkDirectory(target, linkPath) {
  try {
    fs.symlinkSync(target, linkPath, process.platform === "win32" ? "junction" : "dir");
    return true;
  } catch {
    return false;
  }
}

function prepareState(stateDir, mockPort) {
  fs.mkdirSync(stateDir, { recursive: true });
  const extensionsDir = path.join(stateDir, "extensions");
  fs.mkdirSync(extensionsDir, { recursive: true });

  const pluginLink = path.join(extensionsDir, "deepseek-search");
  if (!fs.existsSync(pluginLink) && !linkDirectory(REPO_ROOT, pluginLink)) {
    throw new Error(`could not link ${REPO_ROOT} into ${pluginLink}`);
  }

  const config = {
    gateway: {
      mode: "local",
      port: 19999,
      bind: "loopback",
      auth: { mode: "token", token: "e2e-isolated-token" },
    },
    agents: { defaults: { workspace: path.join(stateDir, "workspace") } },
    tools: {
      web: { search: { enabled: true, provider: "deepseek-search", cacheTtlMinutes: 0 } },
    },
    plugins: {
      entries: {
        "deepseek-search": {
          enabled: true,
          config: {
            webSearch: {
              apiKey: API_KEY,
              baseUrl: `http://127.0.0.1:${mockPort}`,
              timeoutSeconds: 10,
            },
          },
        },
      },
    },
  };
  const configPath = path.join(stateDir, "openclaw.json");
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2), "utf8");
  return configPath;
}

function runCli(cliPath, stateDir, args, { timeoutMs = 120_000 } = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [cliPath, ...args], {
      cwd: stateDir,
      env: {
        ...process.env,
        OPENCLAW_STATE_DIR: stateDir,
        OPENCLAW_CONFIG_PATH: path.join(stateDir, "openclaw.json"),
      },
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    const timer = setTimeout(() => child.kill(), timeoutMs);
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}

function parseJsonOutput(result) {
  const text = result.stdout.trim();
  const start = text.search(/[[{]/);
  if (start < 0) {
    throw new Error(
      `no JSON in CLI output (exit ${result.code})\nstdout:\n${text.slice(0, 800)}\nstderr:\n${result.stderr.slice(0, 800)}`,
    );
  }
  return JSON.parse(text.slice(start));
}

// ---------------------------------------------------------------------------

const cli = resolveOpenclawCli();
if (!cli) {
  console.log(
    "deepseek-search end-to-end test skipped: no openclaw CLI found.\n" +
      "Install the peer dependency (`npm install`) or set OPENCLAW_CLI to openclaw.mjs.",
  );
  process.exit(0);
}

console.log(`deepseek-search end-to-end test (isolated state + mock API)\n  cli: ${cli}\n`);

const { server: mock, port: mockPort } = await startMock();
const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-deepseek-e2e-"));
try {
  prepareState(stateDir, mockPort);

  await test('config validation accepts provider "deepseek-search"', async () => {
    const result = await runCli(cli, stateDir, ["config", "validate", "--json"]);
    const payload = parseJsonOutput(result);
    assert(
      result.code === 0,
      `config validate exited ${result.code}: ${result.stdout}${result.stderr}`,
    );
    const validity = payload.valid ?? payload.ok;
    assert(validity === true, `config invalid: ${JSON.stringify(payload).slice(0, 1200)}`);
  });

  await test("provider is listed as a web-search provider", async () => {
    const result = await runCli(cli, stateDir, ["infer", "web", "providers", "--json"]);
    const payload = parseJsonOutput(result);
    const text = JSON.stringify(payload);
    assert(text.includes("deepseek-search"), `provider missing from list: ${text.slice(0, 1500)}`);
  });

  await test("real pipeline returns normalized results from the mock API", async () => {
    requests.length = 0;
    const result = await runCli(cli, stateDir, [
      "infer",
      "web",
      "search",
      "--provider",
      "deepseek-search",
      "--query",
      "site:example.com deepseek 搜索",
      "--json",
    ]);
    const payload = parseJsonOutput(result);
    console.log("         CLI output:", JSON.stringify(payload).slice(0, 600));

    assert(requests.length === 1, `expected 1 upstream request, got ${requests.length}`);
    assert(requests[0].url === "/v1/tools/search", `unexpected path ${requests[0].url}`);
    assert(requests[0].body.query === "site:example.com deepseek 搜索", "query was altered");
    assert(
      requests[0].headers.authorization === `Bearer ${API_KEY}`,
      "authorization header missing",
    );

    const text = JSON.stringify(payload);
    assert(text.includes("example.com"), "result urls missing from output");
    assert(text.includes("Example Domain"), "result titles missing from output");
    assert(!text.includes(API_KEY), "CLI output must not contain the API key");
  });

  await test("--limit is honoured end to end", async () => {
    requests.length = 0;
    const result = await runCli(cli, stateDir, [
      "infer",
      "web",
      "search",
      "--provider",
      "deepseek-search",
      "--query",
      "limit-test",
      "--limit",
      "2",
      "--json",
    ]);
    parseJsonOutput(result);
    assert(requests.length === 1, `expected 1 upstream request, got ${requests.length}`);
    assert(requests[0].body.count === 2, `expected count=2, got ${requests[0].body.count}`);
  });

  await test("missing credential is reported, not crashed", async () => {
    const configPath = path.join(stateDir, "openclaw.json");
    const base = JSON.parse(fs.readFileSync(configPath, "utf8"));
    const saved = JSON.stringify(base.plugins.entries["deepseek-search"]);
    base.plugins.entries["deepseek-search"] = {
      enabled: true,
      config: { webSearch: { baseUrl: `http://127.0.0.1:${mockPort}` } },
    };
    fs.writeFileSync(configPath, JSON.stringify(base, null, 2), "utf8");
    try {
      const result = await runCli(cli, stateDir, [
        "infer",
        "web",
        "search",
        "--provider",
        "deepseek-search",
        "--query",
        "no-key",
        "--json",
      ]);
      const text = `${result.stdout}${result.stderr}`;
      assert(
        result.code !== 0 || /missing|api key|DEEPSEEK_API_KEY/i.test(text),
        `unexpected output: ${text.slice(0, 800)}`,
      );
    } finally {
      base.plugins.entries["deepseek-search"] = JSON.parse(saved);
      fs.writeFileSync(configPath, JSON.stringify(base, null, 2), "utf8");
    }
  });
} finally {
  await new Promise((resolve) => mock.close(resolve));
  fs.rmSync(stateDir, { recursive: true, force: true });
}

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length > 0) {
  for (const { name, error } of failures) {
    console.error(`\n--- ${name} ---\n${error?.stack ?? error}`);
  }
  process.exit(1);
}
