import {
  GcliMcpBridge,
  Config,
  ApprovalMode,
  sessionId,
  loadServerHierarchicalMemory,
  FileDiscoveryService,
  DEFAULT_GEMINI_MODEL,
  DEFAULT_GEMINI_EMBEDDING_MODEL,
  MCPServerConfig,
} from '@google/gemini-cli-core';
import { loadSettings, Settings } from './config/settings.js';
import { loadExtensions, Extension } from './config/extension.js';
import { getCliVersion } from './utils/version.js';
import { loadEnvironment } from './config/config.js';
import { loadSandboxConfig } from './config/sandboxConfig.js';

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
  const portArg = process.argv.find((arg) => arg.startsWith('--port='));
  const port = portArg ? parseInt(portArg.split('=')[1], 10) : 8765;

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
  const fileService = new FileDiscoveryService(workspaceRoot);
  const extensionContextFilePaths = extensions.flatMap((e) => e.contextFiles);
  const { memoryContent, fileCount } = await loadServerHierarchicalMemory(
    workspaceRoot,
    settings.merged.debugMode || false,
    fileService,
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
    model: settings.merged.model || DEFAULT_GEMINI_MODEL,
    embeddingModel: DEFAULT_GEMINI_EMBEDDING_MODEL,
    targetDir: workspaceRoot,
    cwd: workspaceRoot,
    debugMode: settings.merged.debugMode || false,
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

  // 4. 初始化并启动 MCP 桥接服务
  const mcpBridge = new GcliMcpBridge(config, cliVersion);
  await mcpBridge.start(port);

  console.log(`Gemini CLI MCP Bridge is running on port ${port}`);
}

startMcpServer().catch((error) => {
  console.error('Failed to start Gemini CLI MCP Bridge:', error);
  process.exit(1);
});
