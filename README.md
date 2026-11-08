# openclaw-plugin-deepseek-search

[![test](https://github.com/MingShou-bot/openclaw-plugin-deepseek-search/actions/workflows/test.yml/badge.svg)](https://github.com/MingShou-bot/openclaw-plugin-deepseek-search/actions/workflows/test.yml)
[![license: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

DeepSeek 原生搜索引擎，作为 **OpenClaw 托管 `web_search`** 的一个 provider 插件。

OpenClaw 内置的搜索 provider（Brave、DuckDuckGo、Exa、Firecrawl、Gemini、Grok、
Kimi、MiniMax、Ollama、Parallel、Perplexity、SearXNG、Tavily）里没有 DeepSeek，
这个插件补上：`POST https://api.deepseek.com/v1/tools/search`。

> **非官方**。本项目由社区维护，与 DeepSeek、OpenClaw 官方均无隶属关系。
> 名字里的 `deepseek` 只表示"访问的是 DeepSeek 的 API"。

- Provider / 插件 id：`deepseek-search`
- 依赖：只用 `openclaw/plugin-sdk/plugin-entry` 这个公开入口，无第三方运行时依赖
- 宿主：OpenClaw `>= 2026.10.9`，Node `>= 24.22.1`
- 只注册 `webSearchProviders`，**不改动 `web_fetch` 的任何默认路由**

## 安装

```bash
# 从 GitHub 仓库安装（OpenClaw 支持 git 仓库作为 install 源）
openclaw plugins install https://github.com/MingShou-bot/openclaw-plugin-deepseek-search

# 或者手动放到 extensions 目录后
openclaw plugins enable deepseek-search
```

装完确认能加载：

```bash
openclaw plugins inspect deepseek-search --runtime
# Status: loaded
# webSearchProviderIds: ["deepseek-search"]
```

## 启用

写 key 并把 `web_search` 指过来。先 dry-run：

```bash
openclaw config patch --stdin --dry-run --json <<'EOF'
{
  plugins: { entries: { "deepseek-search": {
    enabled: true,
    config: { webSearch: { apiKey: "sk-..." } },
  } } },
  tools: { web: { search: { enabled: true, provider: "deepseek-search" } } },
}
EOF
```

`ok: true` 之后去掉 `--dry-run` 正式写入。

> 注意：`--json` 只能和 `--dry-run` 一起用，正式写入时必须去掉 `--json`
> （否则报 `--json requires --dry-run`）。

key 也可以用 SecretRef，避免明文落盘：

```json
{ "source": "env", "id": "DEEPSEEK_API_KEY" }
```

或者干脆不写配置，让 gateway 进程环境里存在 `DEEPSEEK_API_KEY`。

生效：

```bash
openclaw plugins reload deepseek-search     # 不需要重启 gateway
```

验收：

```bash
openclaw infer web search --provider deepseek-search --query "DeepSeek 搜索 API" --json
```

## 配置项

全部在 `plugins.entries.deepseek-search.config.webSearch.*`：

| 键 | 类型 | 默认 | 说明 |
| --- | --- | --- | --- |
| `apiKey` | string \| SecretRef | — | 优先于 `DEEPSEEK_API_KEY` |
| `baseUrl` | string | `https://api.deepseek.com` | 私有网关时改这里 |
| `maxResults` | integer 1–50 | 10 | 工具调用没传 `count` 时的默认条数 |
| `needContent` | boolean | false | 默认带 `need_content: true`，返回正文（慢、体积大） |
| `localization` | string | — | 透传给 API 的 `localization` |
| `timeoutSeconds` | number 1–300 | 30 | 单次请求超时 |
| `cacheTtlMinutes` | number ≥0 | 15 | 进程内缓存相同查询；`0` 关闭 |

工具参数：`query`（必填）、`count`、`need_content`、`ori_question`。

`tools.web.search.cacheTtlMinutes` 也生效，插件侧配置优先。

## 行为细节

- **查询运算符原样透传**：`site:` / `-site:` / `-term` / `"phrase"` /
  `lang:` / `after:` / `before:` 不做任何转义或改写。
- **凭证安全**：上游错误只抛 `DeepSeek Search API error (HTTP <code>)`，
  不回显响应体（响应体可能回显 key）。有测试专门断言这一点。
- **取消与超时**：`context.signal` 直接转发给 `fetch`；超时用
  `AbortSignal.timeout` 合成，核心会渲染成 "Search timed out"。
- **缺 key**：返回 `{error: "missing_deepseek_api_key"}`，符合核心
  `^missing_[a-z0-9_]*api_key$` 的结构化可用性约定，可以让自动选择回退。
- **成本**：$0.75 / 1000 次成功请求；失败、空结果、超时不计费。缓存只在
  gateway 进程内有效，重启即失效。

## 已知限制

- OpenClaw 的 `web_search` 归一化只保留**前 10 条**结果（`web-search-output`
  里写死 `slice(0,10)`），插件虽然接受 `count: 1–50`，模型最多看到 10 条。
- 使用 Node 内置 `fetch`，没有走宿主的 `withTrustedWebSearchEndpoint`
  SSRF 守卫；endpoint 固定为 `api.deepseek.com` 或你显式配置的 `baseUrl`，
  不要指向不可信地址。
- 缓存是进程内 Map，不跨 gateway 重启，也不跨多实例。

## 开发

```bash
git clone https://github.com/MingShou-bot/openclaw-plugin-deepseek-search
cd openclaw-plugin-deepseek-search
npm install          # 只为拿到 openclaw 宿主包（peer/dev）
npm test             # 20 项契约测试 + 5 项端到端测试，都不需要真实 key
```

两个测试套件：

- `tests/harness.mjs` — 离线契约测试：请求形状、结果映射、运算符透传、
  `count` 夹取、缓存、取消、超时、错误不泄密。其中两项直接 import 宿主
  真实的 `web-search-output-*.mjs`，用真正的 `normalizeWebSearchOutput`
  断言 payload 落到 `kind:"results"` 而不是 `kind:"raw"`。宿主大版本升级后
  这两项最值得重跑。
- `tests/e2e.mjs` — 起一个本地 mock 的 DeepSeek API，用临时
  `OPENCLAW_STATE_DIR` 跑真实 `openclaw infer web search`，验证
  发现 → provider 选择 → tool 构造 → HTTP → 归一化整条链路。
  找不到 `openclaw` CLI 时会自动 skip（可用 `OPENCLAW_CLI` 指定）。

### 为什么是手写 ESM 而不是 TypeScript

单文件、零依赖、无构建步骤：`dist/index.js` 就是源码，改完 `node --check`
即可，宿主侧 `plugins reload` 就能生效。少一个构建环节就少一类"发布产物
和源码不一致"的问题。

## 贡献

欢迎 issue / PR。提交前请跑 `npm test`。PR 里附带"怎么验证"的证据会比
单纯的代码更受欢迎。

## License

[MIT](LICENSE)
