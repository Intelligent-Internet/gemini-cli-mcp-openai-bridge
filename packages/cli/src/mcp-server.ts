import { GcliMcpBridge } from '@google/gemini-cli-core';
import { loadCliConfig } from './config/config.js';
import { loadSettings } from './config/settings.js';
import { loadExtensions } from './config/extension.js';
import { sessionId, ApprovalMode } from '@google/gemini-cli-core';
import { getCliVersion } from './utils/version.js';

async function startMcpServer() {
  // 1. 获取命令行参数 (例如，监听的端口)
  const port = parseInt(process.argv[2] || '8765', 10);
  if (isNaN(port)) {
    console.error('Invalid port number provided.');
    process.exit(1);
  }

  console.log('Starting Gemini CLI in MCP Server Mode...');

  // 2. 复用现有的配置加载逻辑
  const workspaceRoot = process.cwd();
  const settings = loadSettings(workspaceRoot);
  const extensions = loadExtensions(workspaceRoot);
  const cliVersion = await getCliVersion();

  // 加载配置，并强制设置为非交互模式
  const config = await loadCliConfig(
    settings.merged,
    extensions,
    sessionId,
  );
  config.setApprovalMode(ApprovalMode.YOLO); // 关键：所有工具调用都自动批准

  // 3. 初始化并启动 MCP 桥接服务
  const mcpBridge = new GcliMcpBridge(config, cliVersion);
  await mcpBridge.start(port);

  console.log(`Gemini CLI MCP Bridge is running on port ${port}`);
}

startMcpServer().catch((error) => {
  console.error('Failed to start Gemini CLI MCP Bridge:', error);
  process.exit(1);
});
