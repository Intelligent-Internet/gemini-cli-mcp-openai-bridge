# Gemini CLI - MCP / OpenAI Bridge Server (`@gemini-community/gemini-mcp-server`)

`@gemini-community/gemini-mcp-server` is a versatile companion application designed to serve as a powerful extension for the `gemini-cli` ecosystem. It primarily fulfills two core roles:

1.  **MCP (Model-Context Protocol) Server**: It hosts and exposes `gemini-cli`'s powerful built-in tools (e.g., `google_web_search`, file system tools) via a standard, discoverable protocol. This allows the core `gemini-cli` model to invoke these tools as needed.

2.  **OpenAI-Compatible API Bridge**: It provides an endpoint compatible with the OpenAI Chat Completions API. This enables any third-party tool or application that supports the OpenAI API (such as [Open WebUI](https://github.com/open-webui/open-webui)) to seamlessly interact with the underlying Gemini model of `gemini-cli`, including full support for streaming responses.

## Core Design Philosophy

The server is built on a principle of **minimal modification and maximum reuse**. It is not a reimplementation of `gemini-cli`'s features but is instead intelligently built on top of the `@google/gemini-cli-core` package.

By reusing the `Config` and `GeminiClient` classes from the core package, the `mcp-server` inherits all of the essential business logic, tool execution capabilities, and configuration management of the main CLI. This design ensures behavioral consistency and simplifies maintenance and extension.

## Features

-   **Hosts Native `gemini-cli` Tools**: Exposes the built-in tools (file system operations, web fetching, web search, etc.) to the `gemini-cli` model via the MCP protocol.
-   **OpenAI API Compatibility**: Provides `/v1/chat/completions` and `/v1/models` endpoints, allowing third-party applications to interact with the Gemini model as if it were an OpenAI service.
-   **Streaming Support**: Fully supports streaming responses, pushing real-time generation results from the Gemini model to the client via Server-Sent Events (SSE).
-   **Flexible Model Configuration**: Allows a separate, default LLM model to be configured via an environment variable specifically for tools hosted by the server (e.g., for summarizing search results).
-   **Inherited Configuration & Authentication**: Automatically uses the same settings and authentication state as your main `gemini-cli` setup.
-   **Forced YOLO Mode**: Runs in a permanent "YOLO" mode, automatically approving all tool calls for streamlined, non-interactive use by other applications.

## Architecture & Interaction Flow

The `mcp-server` operates as a standalone component within the `gemini-cli` ecosystem with the following interaction flow:

1.  **Configuration Loading**: On startup, the server loads user and workspace `settings.json` files and reads environment variables, just like the main `gemini-cli` application, to initialize an instance of the `@google/gemini-cli-core` `Config` class.
2.  **Authentication**: The server **does not** handle its own authentication. It relies entirely on the established authentication state of `gemini-cli` (see the next section for details).
3.  **MCP Service**: It starts an MCP server, which the `gemini-cli` can connect to when it needs to discover and execute tools.
4.  **OpenAI Bridge**: It starts an Express web server that listens for API requests in the OpenAI format.
5.  **Request Handling**:
    -   When an OpenAI-formatted request is received, the server converts it into a format that `gemini-cli-core` can understand.
    -   It uses the reused `Config` instance to get a `GeminiClient`.
    -   A **new, isolated `GeminiChat` session** is created for each incoming API request to prevent conversation history from leaking between different clients.
    -   The request is sent to the Gemini API via the `GeminiClient`.
    -   If the Gemini API's response is streaming, the server transforms it into an OpenAI-compatible SSE stream; otherwise, it returns a complete JSON response.

## Authentication Mechanism

Crucially, the `mcp-server` **does not manage its own credentials**. It shares the exact same authentication mechanism as the main `gemini-cli` tool to ensure seamless and secure operation.

The source of authentication credentials follows the identical priority and lookup logic as `gemini-cli`:

-   **Cached Credentials**: If you have previously logged in through the interactive `gemini-cli` flow (e.g., `gcloud auth application-default login` or OAuth web login), the `mcp-server` will automatically use the cached credentials stored in `~/.config/gcloud` or `~/.gemini`.
-   **Environment Variables**: The server will look for and use standard Google Cloud and Gemini environment variables, such as:
    -   `GEMINI_API_KEY`
    -   `GOOGLE_APPLICATION_CREDENTIALS`
    -   `GOOGLE_CLOUD_PROJECT`

This means that as long as your `gemini-cli` itself is configured correctly and works, the `mcp-server` will be authorized automatically, with no extra authentication steps required.

## Important Security Note: YOLO Mode

The `mcp-server` is designed for non-interactive, programmatic use. As such, it runs with a permanent **YOLO (You Only Live Once) Mode** enabled (`approvalMode: ApprovalMode.YOLO`).

This means that any tool call requested by the model (e.g., `run_shell_command`, `replace`) will be **executed immediately without user confirmation**.

**Warning:** Be extremely cautious when exposing this server to a network. Any client that can reach the server will be able to execute tools with the same permissions as the user running the server process.

## Configuration Options

You can configure the server's behavior via command-line arguments and environment variables.

### Command-Line Arguments

-   `--port=<number>`: Specifies the port for the server to listen on.
    -   **Default**: `8765`
-   `--debug`: Enables detailed debug logging to the console.

### Environment Variables

-   `GEMINI_TOOLS_DEFAULT_MODEL`: Sets a default LLM model specifically for tools hosted by the server (like `google_web_search`).
    -   **Purpose**: When a tool needs to invoke an LLM during its execution (e.g., to summarize search results), it will use the model specified by this variable. This allows you to use a different (potentially faster or cheaper) model for tool execution than for the main chat.
    -   **Example**: `GEMINI_TOOLS_DEFAULT_MODEL=gemini-1.5-flash`

## Usage

### 1. Installation & Build

From the root of the `gemini-cli` project, ensure all dependencies are installed and then build the `mcp-server` package.

```bash
# From the project root
npm install
npm run build --workspace=@gemini-community/gemini-mcp-server
```

### 2. Starting the Server

You can start the server using the `npm run start` command from the root directory, targeting the workspace.

```bash
# Start the server with default configuration
npm run start --workspace=@gemini-community/gemini-mcp-server

# Start on a different port with debug mode enabled
npm run start --workspace=@gemini-community/gemini-mcp-server -- --port=9000 --debug

# Use a faster model for tool calls
GEMINI_TOOLS_DEFAULT_MODEL=gemini-1.5-flash npm run start --workspace=@gemini-community/gemini-mcp-server
```

When the server starts successfully, you will see output similar to this:

```
🚀 Gemini CLI MCP Server and OpenAI Bridge are running on port 8765
   - MCP transport listening on http://localhost:8765/mcp
   - OpenAI-compatible endpoints available at http://localhost:8765/v1
⚙️  Using default model for tools: gemini-2.5-pro
```

### 3. Testing the Endpoints

You can use `curl` or any API client to test the server.

**Test OpenAI Chat Completions (Streaming)**:

```bash
curl -N http://localhost:8765/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "gemini-pro",
    "messages": [{"role": "user", "content": "Tell me a short story about a robot who learns to paint."}],
    "stream": true
  }'
```

**Test OpenAI Chat Completions (Non-Streaming)**:

```bash
curl http://localhost:8765/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "gemini-pro",
    "messages": [{"role": "user", "content": "Why is the sky blue?"}],
    "stream": false
  }'
```

## Telemetry, Terms of Service, and Privacy

### Telemetry

The `@gemini-community/gemini-mcp-server` **does not introduce any new telemetry or data collection mechanisms**.

It relies entirely on the OpenTelemetry (OTEL) system built into the `@google/gemini-cli-core` package. Therefore, all telemetry data (if enabled) will follow the main `gemini-cli` configuration and be sent to the destination specified in your `settings.json` file.

For details on how to configure and use telemetry, please refer to the [main Gemini CLI telemetry documentation](../../docs/telemetry.md).

### Terms of Service and Privacy Notice

Your use of this server is governed by the Terms of Service and Privacy Policies corresponding to the `gemini-cli` account type you are using for authentication. As a bridge, `@gemini-community/gemini-mcp-server` does not collect, store, or process any additional data of its own.

We strongly recommend you review the [main Gemini CLI Terms of Service and Privacy Notice documentation](../../docs/tos-privacy.md) for details applicable to your account.

---

### Developer Note: Regarding the package name `@gemini-community/gemini-mcp-server`

Please note that the name of this package, `@gemini-community/gemini-mcp-server`, indicates that it is a community-maintained package.

-   **Community Driven**: This package is part of the Gemini Community effort to extend the capabilities of `gemini-cli`.
-   **Publication**: This package may be published to a public npm registry under the `@gemini-community` scope. If you fork this project and wish to publish your own modified version, you **must** change the package name to your own scope (e.g., `@your-username/gemini-mcp-server`) to comply with npm's package naming policies and to avoid confusion.

----

# Gemini CLI - MCP / OpenAI Bridge Server (`@gemini-community/gemini-mcp-server`)

`@gemini-community/gemini-mcp-server` 是一个多功能的服务器应用程序，旨在作为 `gemini-cli` 生态系统的强大扩展。它主要承担两个核心角色：

1.  **MCP (Model-Context Protocol) 服务器**: 它为 `gemini-cli` 托管和暴露了一系列强大的内置工具（例如 `google_web_search`），允许 `gemini-cli` 的核心模型通过一个标准的、可发现的协议来调用这些工具。

2.  **OpenAI 兼容的 API 桥接器**: 它提供了一个与 OpenAI Chat Completions API 兼容的端点。这使得任何支持 OpenAI API 的第三方工具或应用程序（例如 [Open WebUI](https://github.com/open-webui/open-webui)）都可以无缝地与 `gemini-cli` 的底层 Gemini 模型进行交互，包括利用流式响应。

## 核心设计理念

这个服务器的核心设计原则是 **最小化修改和最大化复用**。它并不是对 `gemini-cli` 功能的重新实现，而是巧妙地构建在 `@google/gemini-cli-core` 包之上。

通过重用 `core` 包中的 `Config` 和 `GeminiClient` 类，`mcp-server` 继承了 `gemini-cli` 所有的核心业务逻辑、工具执行能力和配置管理机制。这种设计确保了行为的一致性，并使得维护和扩展变得更加简单。

## 功能特性

-   **托管原生 `gemini-cli` 工具**: 通过 MCP 协议，将 `gemini-cli` 的内置工具（如文件系统操作、网页抓取、网络搜索等）暴露给 `gemini-cli` 模型。
-   **OpenAI API 兼容性**: 提供 `/v1/chat/completions` 和 `/v1/models` 端点，允许第三方应用程序像与 OpenAI 对话一样与 Gemini 模型交互。
-   **流式响应支持**: 完全支持流式响应，可以将 Gemini 模型的实时生成结果通过 SSE (Server-Sent Events) 推送给客户端。
-   **灵活的模型配置**: 允许通过环境变量为服务器托管的工具（如 `google_web_search`）配置一个特定的、独立的默认 LLM 模型。

## 架构与交互流程

`mcp-server` 作为 `gemini-cli` 生态系统中的一个独立组件，其交互流程如下：

1.  **配置加载**: 服务器启动时，它会像主 `gemini-cli` 应用一样，加载用户和工作区的 `settings.json` 文件，并读取环境变量来初始化一个 `@google/gemini-cli-core` 的 `Config` 实例。
2.  **认证**: 服务器**不处理**自己的认证流程。它完全依赖于 `gemini-cli` 已经建立的认证状态（详情见下一节）。
3.  **MCP 服务**: 它启动一个 MCP 服务器，`gemini-cli` 在需要时可以连接到这个服务器来发现和执行工具。
4.  **OpenAI 桥接**: 它启动一个 Express Web 服务器，监听 OpenAI 格式的 API 请求。
5.  **请求处理**:
    -   当收到一个 OpenAI 格式的请求时，服务器会将其转换为 `gemini-cli-core` 可以理解的格式。
    -   它使用复用的 `Config` 实例来获取一个 `GeminiClient`。
    -   通过 `GeminiClient` 将请求发送给 Gemini API。
    -   如果 Gemini API 的响应是流式的，服务器会将其转换为 OpenAI 兼容的 SSE 事件流；如果是非流式的，则返回一个完整的 JSON 响应。

## 认证机制

至关重要的是，`mcp-server` **不管理自己的认证凭据**。它与主 `gemini-cli` 工具共享相同的认证机制，以确保无缝和安全的操作。

认证凭据的来源遵循与 `gemini-cli` 完全相同的优先级和查找逻辑：

-   **缓存的凭据**: 如果您之前通过 `gemini-cli` 的交互式流程（例如 `gcloud auth application-default login` 或 OAuth 网页登录）登录过，`mcp-server` 会自动使用存储在 `~/.config/gcloud` 或 `~/.gemini` 目录下的缓存凭据。
-   **环境变量**: 服务器会查找并使用标准的 Google Cloud 和 Gemini 环境变量，例如：
    -   `GEMINI_API_KEY`
    -   `GOOGLE_APPLICATION_CREDENTIALS`
    -   `GOOGLE_CLOUD_PROJECT`

这意味着，只要您的 `gemini-cli` 本身配置正确且可以工作，`mcp-server` 就能自动获得授权，无需任何额外的认证步骤。

## 配置选项

您可以通过命令行参数和环境变量来配置服务器的行为。

### 命令行参数

-   `--port=<number>`: 指定服务器监听的端口。
    -   **默认值**: `8765`
-   `--debug`: 启用详细的调试日志输出。

### 环境变量

-   `GEMINI_TOOLS_DEFAULT_MODEL`: 为服务器托管的工具（如 `google_web_search`）设置一个默认的 LLM 模型。
    -   **用途**: 当一个工具在执行过程中需要调用 LLM（例如，对搜索结果进行总结）时，它将使用此环境变量指定的模型。这允许您为主聊天和工具执行使用不同的模型，从而可能优化成本和速度。
    -   **示例**: `GEMINI_TOOLS_DEFAULT_MODEL=gemini-1.5-flash`

## 使用方法

### 1. 安装与构建

在 `gemini-cli` 项目的根目录下，确保所有依赖已安装，并构建 `mcp-server` 包。

```bash
# 在项目根目录运行
npm install
npm run build --workspace=@gemini-community/gemini-mcp-server
```

### 2. 启动服务器

您可以使用 `npm run start` 命令来启动服务器。

```bash
# 启动服务器，使用默认配置
npm run start --workspace=@gemini-community/gemini-mcp-server

# 在不同端口上启动，并启用调试模式
npm run start --workspace=@gemini-community/gemini-mcp-server -- --port=9000 --debug

# 使用一个更快的模型进行工具调用
GEMINI_TOOLS_DEFAULT_MODEL=gemini-1.5-flash npm run start --workspace=@gemini-community/gemini-mcp-server
```

服务器成功启动后，您将看到类似以下的输出：

```
🚀 Gemini CLI MCP Server and OpenAI Bridge are running on port 8765
   - MCP transport listening on http://localhost:8765/mcp
   - OpenAI-compatible endpoints available at http://localhost:8765/v1
⚙️  Using default model for tools: gemini-2.5-pro
```

### 3. 测试端点

您可以使用 `curl` 或任何 API 客户端来测试服务器。

**测试 OpenAI Chat Completions (流式)**:

```bash
curl -N http://localhost:8765/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "gemini-pro",
    "messages": [{"role": "user", "content": "Tell me a short story about a robot who learns to paint."}],
    "stream": true
  }'
```

## 遥测、服务条款和隐私

### 遥测 (Telemetry)

`@google/gemini-mcp-server` 本身**不引入任何新的遥测或数据收集机制**。

它完全依赖于 `@google/gemini-cli-core` 包中内置的 OpenTelemetry (OTEL) 系统。因此，所有的遥测数据（如果启用）都将遵循 `gemini-cli` 的主配置，并被发送到 `settings.json` 文件中指定的目标。

关于如何配置和使用遥测，请参阅[主 Gemini CLI 遥测文档](../../docs/telemetry.md)。

### 服务条款 (Terms of Service) 和隐私声明 (Privacy Notice)

本服务器的使用受制于您用于认证的 `gemini-cli` 账户类型所对应的服务条款和隐私政策。`@google/gemini-mcp-server` 作为一个桥接工具，本身不收集、存储或处理您的任何额外数据。

我们强烈建议您查阅[主 Gemini CLI 服务条款和隐私声明文档](../../docs/tos-privacy.md)以了解适用于您账户的详细信息。

---

### 开发者说明：关于包名 `@google/gemini-mcp-server`

请注意，本包的名称 `@google/gemini-mcp-server` 反映了它作为官方 `google-gemini/gemini-cli` 的fork项目的 monorepo 内部组件的来源。

-   **内部命名**: 在 `gemini-cli` 项目的源代码和工作区中，此命名是内部一致的。
-   **非独立发布**: 此包**不会**作为一个独立的、版本化的包发布到公共 npm registry 上。如果您 fork 本项目并希望独立发布您的修改版本，您**必须**将包名更改为您自己的 scope（例如 `@your-username/gemini-mcp-server`），以遵守 npm 的包命名规范并避免混淆。
