<h1 align="center">MCP Web Tools</h1>

<p align="center">
  为 ChatGPT plugin 和其他 MCP 客户端接入实时网页、文档与 HTTP API。<br>
  两个轻量服务，部署在你自己的 Cloudflare Workers 账户中。
</p>

<p align="center">
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue" alt="MIT 许可证"></a>
  <img src="https://img.shields.io/badge/Cloudflare-Workers-F38020?logo=cloudflare&logoColor=white" alt="Cloudflare Workers">
  <img src="https://img.shields.io/badge/MCP-Streamable_HTTP-2DF9C0" alt="MCP：Streamable HTTP">
  <a href="https://github.com/ZhenHuangLab/mcp-web-tools/actions/workflows/ci.yml"><img src="https://github.com/ZhenHuangLab/mcp-web-tools/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
</p>

<p align="center"><a href="README.md">English</a> · <b>简体中文</b></p>

MCP Web Tools 帮助 ChatGPT 阅读搜索结果背后的完整来源：先用 ChatGPT 的搜索找到网页，再通过 plugin 获取 Markdown 正文；遇到实时 API，则直接获取 JSON 或查看原始 HTTP 响应。这样可以更方便地核对资料、阅读文档、比较来源和查询最新数据。

项目采用 MIT 许可证，免费使用，无需额外购买搜索 API，也无需单独配置 LLM API 密钥。你可以在 Cloudflare Workers 免费计划的额度内运行这两个服务。ChatGPT 账户需要具备自定义 MCP plugin 的使用权限，订阅及工作区要求由 ChatGPT 决定，详见[费用](#费用)。

**用户需要自行部署和运营服务。维护者仅提供源代码，不提供公共或演示 endpoint。** 文档中的 endpoint 地址均为占位符，请将 `<your-subdomain>` 替换为你部署后实际获得的子域名。部署配置已去除个人域名和账户标识。

<img src="assets/chatgpt-web-reader.png" alt="ChatGPT 使用 WebRead MCP plugin 阅读和讨论 arXiv 论文" width="960">

在 ChatGPT 中使用网页阅读器阅读论文。示例中的 `WebRead` 是用户设置的 plugin 显示名称。

## 两个服务

| 服务 | 工具 | 适用场景 |
|---|---|---|
| [网页阅读器](webpage-fetcher/README.md) | `fetch_webpage_to_markdown` | 文章、技术文档、Markdown、PDF 和 Office 文档 |
| [HTTP 工具](public-curl-worker/README.md) | `curl_request`、`fetch_json`、`check_url`、`batch_request` | 实时 API、原始响应、响应头、重定向和小批量请求 |

你可以只部署其中一个，也可以同时部署。每个服务都有独立的 `/mcp` endpoint 和普通 HTTP API。两个服务均在调用时发起请求并要求跳过缓存。阅读器会选择正文、清除导航等内容，并将长文档分段返回。查找网址的步骤由 ChatGPT 搜索或其他搜索工具完成。

## 自行部署

### 准备条件

- Node.js 22 或更高版本，以及 npm。
- 已启用 Workers 的 Cloudflare 账户，可以从免费计划开始使用。
- 网页阅读器还需要 Workers AI 权限，用于 HTML 和文档转换。项目已配置 `AI` 绑定；如果控制台要求激活账户功能或接受服务条款，请先完成。

默认使用 Cloudflare 提供的 `workers.dev` 子域名，可以直接完成部署，无需购买域名或配置 DNS。

### 安装和登录

在你自己的机器上执行：

```sh
git clone https://github.com/ZhenHuangLab/mcp-web-tools.git
cd mcp-web-tools
npm ci
npx wrangler login
npx wrangler whoami
```

Wrangler 会打开浏览器完成 Cloudflare 授权。检查 `whoami` 显示的是否为目标账户。如果你拥有多个账户，请在本地终端将 `CLOUDFLARE_ACCOUNT_ID` 设置为目标账户 ID。无浏览器环境可以按照 [Wrangler 认证文档](https://developers.cloudflare.com/workers/wrangler/system-environment-variables/)配置本地环境变量或密钥存储。请妥善保存令牌，避免将其放入聊天、源码或 Git 提交。

### 检查配置并部署

检查两个服务各自 `wrangler.jsonc` 中的 `name`。如果账户中已有同名 Worker，部署会更新该 Worker；如有需要，请先改名。保留阅读器的 `AI` 绑定。

```sh
npm run check          # 仅打包检查两个 Worker
npm run deploy         # 依次部署阅读器和 HTTP 工具
```

只部署其中一个时，执行对应命令：

```sh
npm run deploy:read
npm run deploy:curl
```

Wrangler 会输出实际访问地址。保留默认 Worker 名称时，MCP endpoint 的格式如下：

```text
https://webpage-fetcher.<your-subdomain>.workers.dev/mcp
https://public-curl-worker.<your-subdomain>.workers.dev/mcp
```

首次使用 Workers 时，请按 Cloudflare 的提示完成 `workers.dev` 子域名设置。修改 Worker 名称后，地址前缀也会变化。

**服务默认没有入站鉴权。任何能够访问你的 Worker 的人都可以调用它，并消耗你的账户额度。** 分享地址前，请检查访问控制、限流和日志设置。HTTP 工具还可以向目标服务发送会修改数据的请求，详见[安全说明](SECURITY.md)。

### 检查部署结果

将下面两个变量替换为 Wrangler 输出的实际源站地址，不包含末尾的 `/mcp`。示例值均为占位符：

```sh
READ_ORIGIN='https://webpage-fetcher.<your-subdomain>.workers.dev'
CURL_ORIGIN='https://public-curl-worker.<your-subdomain>.workers.dev'

curl --fail-with-body "$READ_ORIGIN/"
curl --fail-with-body --get "$READ_ORIGIN/" \
  --data-urlencode 'url=https://example.com'
curl --fail-with-body --get "$CURL_ORIGIN/api/json" \
  --data-urlencode 'url=https://api.github.com/repos/cloudflare/workers-sdk'
```

第一个请求返回阅读器的服务信息，第二个返回网页 Markdown，第三个返回 JSON API 的响应。再启动 MCP Inspector 检查工具发现和调用：

```sh
npx @modelcontextprotocol/inspector@latest
```

在 Inspector 中选择 **Streamable HTTP**，分别连接部署后的 `/mcp` 地址。阅读器应列出一个工具，HTTP 服务应列出四个工具；随后调用你需要使用的工具。

## 接入 ChatGPT plugin

将自行部署的 MCP 添加为 ChatGPT 自定义 plugin，即可增强网页搜索后的正文阅读能力。建议先添加网页阅读器，需要实时 API 或原始 HTTP 响应时再添加 HTTP 工具。

按照 OpenAI 的[自定义 MCP 接入文档](https://developers.openai.com/plugins/deploy/connect-chatgpt)：

1. 打开 [ChatGPT Plugins](https://chatgpt.com/plugins)，点击 **+**，选择 **Add custom MCP server**。
2. 输入名称，例如 `Web Reader`，并填写简短说明。
3. 在 **Connection** 中填写阅读器完整的 HTTPS `/mcp` 地址，传输方式为 Streamable HTTP。
4. 使用项目默认配置时，选择 **No authentication**。阅读风险提示后，点击 **Create as a plugin**。
5. 检查发现的工具，安装 plugin，再开始新对话。需要使用时，在输入框中键入 `@` 并选择它。
6. 如果需要 HTTP 工具，用其 `/mcp` 地址重复以上步骤。

自定义 plugin 的使用权限取决于账户及工作区策略。如果界面没有对应入口，请查看 OpenAI 当前的开放范围和工作区设置。部署更新改变工具信息后，需要在 ChatGPT 中点击 **Refresh**，再开始新对话。

可以尝试以下提示词：

```text
请搜索以下主题的官方资料，然后使用 fetch_webpage_to_markdown 阅读相关网页的完整正文。
如果返回内容尚未结束，请按 startIndex 继续读取。比较各个来源，并在回答中给出来源网址。

主题：Cloudflare Workers 最新版本有哪些变化？
```

查询 API 数据时：

```text
请使用 fetch_json 读取 https://api.github.com/repos/cloudflare/workers-sdk，
告诉我当前的 star 数，并给出本次请求的网址。
```

对于会修改目标数据的请求，请先检查操作内容再批准。其他 MCP 客户端也可以通过各自的 Streamable HTTP 设置连接相同的 endpoint。

<details>
<summary>使用示例：在 ChatGPT 中配合 WebRead 和 Curl</summary>

<img src="assets/chatgpt-web-tools.png" alt="ChatGPT 展示 WebRead 文档读取和 Curl HTTP 请求的使用情况" width="960">

这张用户提供的示例截图使用 `WebRead` 和 `Curl` 作为两个 plugin 的显示名称。

</details>

## 交给 AI agent 自动部署

将下面的提示词交给能够访问你本地终端的编程 agent。它可以完成安装和部署流程，Cloudflare 登录、账户选择和发布授权仍由你确认。

```text
请将 https://github.com/ZhenHuangLab/mcp-web-tools 部署到我自己的 Cloudflare 账户。

1. 将仓库克隆到新目录；如果使用已有目录，先检查其状态。阅读 README.zh-CN.md、
   SECURITY.md、package.json 和两个 wrangler.jsonc。使用 Node.js 22 或更高版本。
2. 执行 npm ci 和 npm run check，使用锁文件及项目配置的依赖版本。
   保留两个 Worker 与 shared 模块在同一份完整仓库中。
3. 执行 npx wrangler whoami。需要登录时，请让我通过 Cloudflare 完成
   npx wrangler login。无浏览器环境请让我在本地配置凭据。
   严禁要求我在聊天中粘贴令牌，也不要打印或提交令牌。
4. 与我确认目标账户及两个 Worker 的名称。说明 endpoint 将通过 HTTPS 对外可达，
   默认没有入站鉴权，并说明免费额度及 Workers AI 绑定。
   部署或更新同名 Worker 前必须取得我的授权。启用付费计划、购买域名或添加其他
   付费服务，均须先取得我的明确授权。
5. 使用 workers.dev，保留阅读器的 AI 绑定。获得授权后执行 npm run deploy；
   如果我只需要一个服务，则只部署该服务。所有示例 endpoint 都是占位符，
   请使用我的账户实际生成的地址。
6. 记录 Wrangler 输出的实际地址。通过 HTTP 检查服务，使用阅读器读取 HTML 网页，
   并按 shared/mcp.js 支持的协议检查 MCP tools/list 和一次无副作用的工具调用。
   先检查错误原因，再决定是否需要改代码。遇到账户权限或激活步骤阻碍时，请停在
   对应步骤并告诉我需要完成的具体操作。
7. 最后给出实际 HTTPS /mcp 地址、已完成的检查、尚未解决的错误，以及接入
   ChatGPT Plugins 的步骤。只报告从本次部署中实际观察到的结果。
```

## 费用

项目不收取订阅费或调用费，也无需额外的搜索服务及 LLM API 密钥。部署后的代码负责发送 HTTP 请求，并使用 Cloudflare 文档转换服务，无需调用付费 LLM API。

Cloudflare Workers 免费计划有请求数量和 CPU 时间限制。按照 Cloudflare 的说明，大部分 `toMarkdown` 格式转换免费；本项目不提供图片转换或 OCR。较大或较复杂的响应可能超过免费计划的 CPU 预算，请观察账户用量，并按实际负载决定是否升级。最新规则请查看 [Workers 限制](https://developers.cloudflare.com/workers/platform/limits/)和 [Markdown 转换费用](https://developers.cloudflare.com/workers-ai/features/markdown-conversion/#pricing)。ChatGPT 按你现有的订阅和工作区规则提供接入权限，项目本身不增加 plugin 订阅费用。

## 本地开发

在仓库根目录分别打开终端，启动需要的服务：

```sh
npm run dev:read
npm run dev:curl
```

Wrangler 会输出各自的本地地址。阅读器的 `remote: true` AI 绑定在本地开发时也会调用 Cloudflare，需要账户权限和网络连接。HTML 预处理使用 Workers 原生的 `HTMLRewriter`。

`npm run check` 仅打包检查两个 Worker，无需部署或 Cloudflare 账户凭据，CI 使用相同命令。部署命令分别作用于对应 Worker，两个服务可以独立更新。

如果需要自定义域名，请在对应 `wrangler.jsonc` 中添加 `routes`，使用你在 Cloudflare 中管理的域名。例如，`reader.example.com` 仅为占位符。具体步骤见 [Cloudflare 自定义域名文档](https://developers.cloudflare.com/workers/configuration/routing/custom-domains/)。

## 限制与安全

阅读器适用于公开网址、静态 HTML 和支持的在线文档。它不运行页面 JavaScript，不登录网站，不处理浏览器验证，也不通过 OCR 读取扫描件。每次分页调用都会重新获取和转换来源，页面发生变化时，不同分段的内容位置也可能变化。

请求经过你的 Cloudflare 账户，HTML 和文档转换还会将内容发送给 Workers AI。两个配置都启用了 Workers 可观测性；处理敏感 URL 或凭据前，请检查 Cloudflare 的日志设置和保留策略。将抓取内容作为不可信数据处理，对会产生实际影响的操作单独确认。

详细参数和使用限制见[阅读器文档](webpage-fetcher/README.md)、[HTTP 工具文档](public-curl-worker/README.md)和[安全说明](SECURITY.md)。欢迎贡献，流程见 [CONTRIBUTING.md](CONTRIBUTING.md)。

## 许可证

MIT，详见 [LICENSE](LICENSE)。各项依赖保留各自的许可证。

## 致谢

感谢 [LINUX DO](https://linux.do/) 社区的支持、知识分享与反馈。感谢 Cloudflare 提供 Workers 和 Markdown 转换能力，也感谢 MCP 社区维护协议与工具。
