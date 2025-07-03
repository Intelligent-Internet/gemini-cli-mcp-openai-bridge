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
import { logger } from './utils/logger.js';

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
  // Simple, standalone argument parsing.
  const args = process.argv.slice(2);
  const portArg = args.find(arg => arg.startsWith('--port='));
  
  // Support GEMINI_MCP_PORT env var. Priority: CLI arg > env var > default.
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
    logger.error(
      'Invalid port number provided. Use --port=<number> or set GEMINI_MCP_PORT environment variable.',
    );
    process.exit(1);
  }

  logger.info('Starting Gemini CLI MCP Server...');

  // Reuse core config loading, but manually construct Config.
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
    logger.error(
      'Auth missing: Please set `selectedAuthType` in .gemini/settings.json or set the GEMINI_API_KEY environment variable.',
    );
    process.exit(1);
  }
  selectedAuthType = selectedAuthType || AuthType.USE_GEMINI;
  await config.refreshAuth(selectedAuthType);
  logger.debug(debugMode, `Using authentication method: ${selectedAuthType}`);

  // Log the model being used for tools. This is now set in loadServerConfig.
  logger.debug(debugMode, `Using model for tools: ${config.getModel()}`);

  // Initialize and start MCP Bridge and OpenAI services.
  const mcpBridge = new GcliMcpBridge(config, cliVersion, debugMode);

  const app = express();
  app.use(express.json({ limit: '50mb' }));

  // Start the MCP service.
  await mcpBridge.start(app);

  // Start OpenAI compatible endpoint.
  const openAIRouter = createOpenAIRouter(config, debugMode);
  app.use('/v1', openAIRouter);

  app.listen(port, () => {
    logger.info('Server running', {
      port,
      mcpUrl: `http://localhost:${port}/mcp`,
      openAIUrl: `http://localhost:${port}/v1`,
    });
  });
}

startMcpServer().catch(error => {
  logger.error('Failed to start Gemini CLI MCP Bridge:', error);
  process.exit(1);
});
