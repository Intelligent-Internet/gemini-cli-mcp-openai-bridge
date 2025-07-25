/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  Config,
  loadServerHierarchicalMemory,
  setGeminiMdFilename as setServerGeminiMdFilename,
  getCurrentGeminiMdFilename,
  ApprovalMode,
  GEMINI_CONFIG_DIR as GEMINI_DIR,
  DEFAULT_GEMINI_FLASH_MODEL,
  DEFAULT_GEMINI_EMBEDDING_MODEL,
  FileDiscoveryService,
  TelemetryTarget,
} from '@google/gemini-cli-core';
import { Settings } from './settings.js';

import { Extension } from './extension.js';
import * as dotenv from 'dotenv';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { loadSandboxConfig } from './sandboxConfig.js';

// Simple console logger for now - replace with actual logger if available
const logger = {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  debug: (...args: any[]) => console.debug('[DEBUG]', ...args),
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  warn: (...args: any[]) => console.warn('[WARN]', ...args),
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  error: (...args: any[]) => console.error('[ERROR]', ...args),
};

// This function is now a thin wrapper around the server's implementation.
// It's kept in the CLI for now as App.tsx directly calls it for memory refresh.
// TODO: Consider if App.tsx should get memory via a server call or if Config should refresh itself.
export async function loadHierarchicalGeminiMemory(
  currentWorkingDirectory: string,
  debugMode: boolean,
  fileService: FileDiscoveryService,
  extensionContextFilePaths: string[] = [],
): Promise<{ memoryContent: string; fileCount: number }> {
  if (debugMode) {
    logger.debug(
      `CLI: Delegating hierarchical memory load to server for CWD: ${currentWorkingDirectory}`,
    );
  }
  // Directly call the server function.
  // The server function will use its own homedir() for the global path.
  return loadServerHierarchicalMemory(
    currentWorkingDirectory,
    debugMode,
    fileService,
    extensionContextFilePaths,
  );
}

export async function loadServerConfig(
  settings: Settings,
  extensions: Extension[],
  sessionId: string,
  debugMode: boolean,
  loadInternalPrompt: boolean,
  toolsModel?: string, // <-- New parameter
  targetDir?: string,
): Promise<Config> {
  loadEnvironment();

  // Set the context filename in the server's memoryTool module BEFORE loading memory
  // TODO(b/343434939): This is a bit of a hack. The contextFileName should ideally be passed
  // directly to the Config constructor in core, and have core handle setGeminiMdFilename.
  // However, loadHierarchicalGeminiMemory is called *before* createServerConfig.
  if (settings.contextFileName) {
    setServerGeminiMdFilename(settings.contextFileName);
  } else {
    // Reset to default if not provided in settings.
    setServerGeminiMdFilename(getCurrentGeminiMdFilename());
  }

  const resolvedTargetDir = targetDir || process.cwd();

  const extensionContextFilePaths = extensions.flatMap((e) => e.contextFiles);

  const fileService = new FileDiscoveryService(resolvedTargetDir);
  // Call the (now wrapper) loadHierarchicalGeminiMemory which calls the server's version
  let memoryContent = '';
  let fileCount = 0;

  if (loadInternalPrompt) {
    const memoryResult = await loadHierarchicalGeminiMemory(
      resolvedTargetDir,
      debugMode,
      fileService,
      extensionContextFilePaths,
    );
    memoryContent = memoryResult.memoryContent;
    fileCount = memoryResult.fileCount;
  }

  const mcpServers = mergeMcpServers(settings, extensions);

  const sandboxConfig = await loadSandboxConfig(settings, {});

  // Priority: CLI arg > env var > fallback env var > default
  const model =
    toolsModel ||
    process.env.GEMINI_TOOLS_DEFAULT_MODEL ||
    process.env.GEMINI_MODEL ||
    DEFAULT_GEMINI_FLASH_MODEL;

  return new Config({
    sessionId,
    embeddingModel: DEFAULT_GEMINI_EMBEDDING_MODEL,
    sandbox: sandboxConfig,
    targetDir: resolvedTargetDir,
    debugMode,
    question: undefined,
    fullContext: false,
    coreTools: settings.coreTools || undefined,
    excludeTools: settings.excludeTools || undefined,
    toolDiscoveryCommand: settings.toolDiscoveryCommand,
    toolCallCommand: settings.toolCallCommand,
    mcpServerCommand: settings.mcpServerCommand,
    mcpServers,
    userMemory: memoryContent,
    geminiMdFileCount: fileCount,
    approvalMode: ApprovalMode.YOLO,
    showMemoryUsage: settings.showMemoryUsage || false,
    accessibility: settings.accessibility,
    telemetry: {
      enabled: settings.telemetry?.enabled,
      target: settings.telemetry?.target as TelemetryTarget,
      otlpEndpoint:
        process.env.OTEL_EXPORTER_OTLP_ENDPOINT ??
        settings.telemetry?.otlpEndpoint,
      logPrompts: settings.telemetry?.logPrompts,
    },
    usageStatisticsEnabled: settings.usageStatisticsEnabled ?? true,
    // Git-aware file filtering settings
    fileFiltering: {
      respectGitIgnore: settings.fileFiltering?.respectGitIgnore,
      enableRecursiveFileSearch:
        settings.fileFiltering?.enableRecursiveFileSearch,
    },
    checkpointing: settings.checkpointing?.enabled,
    proxy:
      process.env.HTTPS_PROXY ||
      process.env.https_proxy ||
      process.env.HTTP_PROXY ||
      process.env.http_proxy,
    cwd: resolvedTargetDir,
    fileDiscoveryService: fileService,
    bugCommand: settings.bugCommand,
    model: model, // <-- Use the new model selection logic
    extensionContextFilePaths,
  });
}

function mergeMcpServers(settings: Settings, extensions: Extension[]) {
  const mcpServers = { ...(settings.mcpServers || {}) };
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
function findEnvFile(startDir: string): string | null {
  let currentDir = path.resolve(startDir);
  while (true) {
    // prefer gemini-specific .env under GEMINI_DIR
    const geminiEnvPath = path.join(currentDir, GEMINI_DIR, '.env');
    if (fs.existsSync(geminiEnvPath)) {
      return geminiEnvPath;
    }
    const envPath = path.join(currentDir, '.env');
    if (fs.existsSync(envPath)) {
      return envPath;
    }
    const parentDir = path.dirname(currentDir);
    if (parentDir === currentDir || !parentDir) {
      // check .env under home as fallback, again preferring gemini-specific .env
      const homeGeminiEnvPath = path.join(os.homedir(), GEMINI_DIR, '.env');
      if (fs.existsSync(homeGeminiEnvPath)) {
        return homeGeminiEnvPath;
      }
      const homeEnvPath = path.join(os.homedir(), '.env');
      if (fs.existsSync(homeEnvPath)) {
        return homeEnvPath;
      }
      return null;
    }
    currentDir = parentDir;
  }
}

export function loadEnvironment(): void {
  const envFilePath = findEnvFile(process.cwd());
  if (envFilePath) {
    dotenv.config({ path: envFilePath, quiet: true });
  }
}
