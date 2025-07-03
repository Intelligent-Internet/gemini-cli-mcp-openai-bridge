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
import { loadSettings, type Settings } from './config/settings.js';
import { loadExtensions, type Extension } from './config/extension.js';
import { getCliVersion } from './utils/version.js';
import { loadServerConfig } from './config/config.js';
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
  
  // 支持环境变量 GEMINI_MCP_PORT，优先级：命令行参数 > 环境变量 > 默认值
  let port: number;
  if (portArg) {
    port = parseInt(portArg.split('=')[1], 10);
  } else if (process.env.GEMINI_MCP_PORT) {
    port = parseInt(process.env.GEMINI_MCP_PORT, 10);
  } else {
    port = 8765;
  }
  
  const debugMode = args.includes('--debug');

  if (isNaN(port)) {
    console.error('Invalid port number provided. Use --port=<number> or set GEMINI_MCP_PORT environment variable.');
    process.exit(1);
  }

  console.log('🚀 Starting Gemini CLI MCP Server...');

  // 2. 复用配置加载的核心部分，但手动构造 Config
  const workspaceRoot = process.cwd();
  const settings = loadSettings(workspaceRoot);
  const extensions = loadExtensions(workspaceRoot);
  const cliVersion = await getCliVersion();

  const config = await loadServerConfig(
    settings.merged,
    extensions,
    sessionId,
    debugMode,
  );

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
  if (debugMode) {
    console.log(`Using authentication method: ${selectedAuthType}`);
  }

  // Log the model being used for tools. This is now set in loadServerConfig.
  console.log(`⚙️  Using model for tools: ${config.getModel()}`);

  // 4. 初始化并启动 MCP 桥接服务 和 OpenAI 服务
  const mcpBridge = new GcliMcpBridge(config, cliVersion, debugMode);

  const app = express();
  app.use(express.json({ limit: '50mb' }));

  // 启动 MCP 服务 (这是 GcliMcpBridge 的一部分，我们需要把它集成到主 app 中)
  await mcpBridge.start(app); // 修改 start 方法以接收 express app 实例

  // 启动 OpenAI 兼容端点
  const openAIRouter = createOpenAIRouter(config, debugMode);
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
