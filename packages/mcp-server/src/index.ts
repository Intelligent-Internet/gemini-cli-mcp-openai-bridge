import {
  Config,
  ApprovalMode,
  sessionId,
  loadServerHierarchicalMemory,
  FileDiscoveryService,
  DEFAULT_GEMINI_MODEL,
  DEFAULT_GEMINI_EMBEDDING_MODEL,
  MCPServerConfig,
  AuthType,
} from '@google/gemini-cli-core';
import {
  loadSettings,
  type Settings,
  loadExtensions,
  type Extension,
  getCliVersion,
  loadEnvironment,
  loadSandboxConfig,
} from '@google/gemini-cli/public-api';
import {
  loadSettings,
  type Settings,
  loadExtensions,
  type Extension,
  getCliVersion,
  loadEnvironment,
  loadSandboxConfig,
} from '@google/gemini-cli/public-api';
import { GcliMcpBridge } from './bridge/bridge.js';
import { createOpenAIRouter } from './bridge/openai.js';
import express from 'express';

// Simple console logger for now
const logger = {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  warn: (...args: any[]) => console.warn('[WARN]', ...args),
};

function mergeMcpServers(
  settings: Settings,
  extensions: Extension[],
): Record<string, MCPServerConfig> {
  const mcpServers: Record<string, MCPServerConfig> = {
    ...(settings.mcpServers || {}),
  };
  for (const extension of extensions) {
    Object.entries(extension.config.mcpServers || {}).forEach(
      ([key, server]) => {
        if (mcpServers[key]) {
          logger.warn(
            `Skipping extension MCP config for server with key "${key}" as it already exists.`,
          );
          return;
        }
        mcpServers[key] = server;
      },
    );
  }
  return mcpServers;
}

async function startMcpServer() {
  // 1. 独立的、简单的参数解析
  const args = process.argv.slice(2);
  const portArg = args.find(arg => arg.startsWith('--port='));
  const port = portArg ? parseInt(portArg.split('=')[1], 10) : 8765;
  const debugMode = args.includes('--debug');

  if (isNaN(port)) {
    console.error('Invalid port number provided. Use --port=<number>.');
    process.exit(1);
  }

  console.log('Starting Gemini CLI in MCP Server Mode...');

  // 2. 复用配置加载的核心部分，但手动构造 Config
  loadEnvironment(); // 加载 .env 文件
  const workspaceRoot = process.cwd();
  const settings = loadSettings(workspaceRoot);
  const extensions = loadExtensions(workspaceRoot);
  const cliVersion = await getCliVersion();

  // 3. 手动构造 ConfigParameters，绕开 yargs
  const fileDiscoveryService = new FileDiscoveryService(workspaceRoot);
  const extensionContextFilePaths = extensions.flatMap(e => e.contextFiles);
  const { memoryContent, fileCount } = await loadServerHierarchicalMemory(
    workspaceRoot,
    debugMode,
    fileDiscoveryService,
    extensionContextFilePaths,
  );

  const mockArgvForSandbox = {};
  const sandboxConfig = await loadSandboxConfig(
    settings.merged,
    mockArgvForSandbox,
  );

  const mcpServers = mergeMcpServers(settings.merged, extensions);

  const config = new Config({
    sessionId: sessionId,
    model: process.env.GEMINI_MODEL || DEFAULT_GEMINI_MODEL,
    embeddingModel: DEFAULT_GEMINI_EMBEDDING_MODEL,
    targetDir: workspaceRoot,
    cwd: workspaceRoot,
    debugMode: debugMode,
    approvalMode: ApprovalMode.YOLO, // 强制为 YOLO 模式
    sandbox: sandboxConfig,
    userMemory: memoryContent,
    geminiMdFileCount: fileCount,
    fileDiscoveryService,
    coreTools: settings.merged.coreTools,
    excludeTools: settings.merged.excludeTools,
    toolDiscoveryCommand: settings.merged.toolDiscoveryCommand,
    toolCallCommand: settings.merged.toolCallCommand,
    mcpServers: mcpServers,
    extensionContextFilePaths,
    showMemoryUsage: settings.merged.showMemoryUsage,
    accessibility: settings.merged.accessibility,
    telemetry: settings.merged.telemetry,
    usageStatisticsEnabled: settings.merged.usageStatisticsEnabled,
    fileFiltering: settings.merged.fileFiltering,
    checkpointing: settings.merged.checkpointing?.enabled,
    proxy:
      process.env.HTTPS_PROXY ||
      process.env.https_proxy ||
      process.env.HTTP_PROXY ||
      process.env.http_proxy,
    bugCommand: settings.merged.bugCommand,
  });

  // Initialize Auth - this is critical to initialize the tool registry and gemini client
  let selectedAuthType = settings.merged.selectedAuthType;
  if (!selectedAuthType && !process.env.GEMINI_API_KEY) {
    console.error(
      'Auth missing: Please set `selectedAuthType` in .gemini/settings.json or set the GEMINI_API_KEY environment variable.',
    );
    process.exit(1);
  }
  selectedAuthType = selectedAuthType || AuthType.USE_GEMINI;
  await config.refreshAuth(selectedAuthType);

  // Initialize Auth - this is critical to initialize the tool registry and gemini client
  let selectedAuthType = settings.merged.selectedAuthType;
  if (!selectedAuthType && !process.env.GEMINI_API_KEY) {
    console.error(
      'Auth missing: Please set `selectedAuthType` in .gemini/settings.json or set the GEMINI_API_KEY environment variable.',
    );
    process.exit(1);
  }
  selectedAuthType = selectedAuthType || AuthType.USE_GEMINI;
  await config.refreshAuth(selectedAuthType);

  // 4. 初始化并启动 MCP 桥接服务 和 OpenAI 服务
  const mcpBridge = new GcliMcpBridge(config, cliVersion);

  const app = express();
  app.use(express.json());

  // 启动 MCP 服务 (这是 GcliMcpBridge 的一部分，我们需要把它集成到主 app 中)
  await mcpBridge.start(app); // 修改 start 方法以接收 express app 实例

  // 启动 OpenAI 兼容端点
  const openAIRouter = createOpenAIRouter(config);
  app.use('/v1', openAIRouter);

  app.listen(port, () => {
    console.log(
      `🚀 Gemini CLI MCP Server and OpenAI Bridge are running on port ${port}`,
    );
    console.log(`   - MCP transport listening on http://localhost:${port}/mcp`);
    console.log(
      `   - OpenAI-compatible endpoints available at http://localhost:${port}/v1`,
    );
  });
}

startMcpServer().catch(error => {
  console.error('Failed to start Gemini CLI MCP Bridge:', error);
  process.exit(1);
});
