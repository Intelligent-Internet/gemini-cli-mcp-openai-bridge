import express, { Request, Response, NextFunction, Application } from 'express';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';
import {
  type Config,
  type Tool as GcliTool,
  type ToolResult,
  GeminiChat,
  WebFetchTool,
  WebSearchTool,
} from '@google/gemini-cli-core';
import {
  type CallToolResult,
  isInitializeRequest,
} from '@modelcontextprotocol/sdk/types.js';
import {
  type PartUnion,
  type Tool,
  type GenerateContentConfig,
  type Content,
} from '@google/genai';
import { randomUUID } from 'node:crypto';
import { logger } from '../utils/logger.js';

export class GcliMcpBridge {
  private readonly config: Config;
  private readonly cliVersion: string;
  private readonly debugMode: boolean;
  private readonly sessions: Record<
    string,
    { mcpServer: McpServer; transport: StreamableHTTPServerTransport }
  > = {};

  constructor(config: Config, cliVersion: string, debugMode = false) {
    this.config = config;
    this.cliVersion = cliVersion;
    this.debugMode = debugMode;
  }

  private async createNewMcpServer(): Promise<McpServer> {
    const server = new McpServer(
      {
        name: 'gemini-cli-mcp-server',
        version: this.cliVersion,
      },
      { capabilities: { logging: {} } },
    );
    await this.registerAllGcliTools(server);
    return server;
  }

  public async start(app: Application) {
    app.all('/mcp', async (req: Request, res: Response) => {
      const sessionId = req.headers['mcp-session-id'] as string | undefined;

      let session = sessionId ? this.sessions[sessionId] : undefined;

      if (!session) {
        if (isInitializeRequest(req.body)) {
          logger.debug(
            this.debugMode,
            'Creating new session and transport for initialize request',
          );

          try {
            const newMcpServer = await this.createNewMcpServer();
            const newTransport = new StreamableHTTPServerTransport({
              sessionIdGenerator: () => randomUUID(),
              onsessioninitialized: newSessionId => {
                logger.debug(
                  this.debugMode,
                  `Session initialized: ${newSessionId}`,
                );
                this.sessions[newSessionId] = {
                  mcpServer: newMcpServer,
                  transport: newTransport,
                };
              },
            });

            newTransport.onclose = () => {
              const sid = newTransport.sessionId;
              if (sid && this.sessions[sid]) {
                logger.debug(
                  this.debugMode,
                  `Session ${sid} closed, removing session object.`,
                );
                delete this.sessions[sid];
              }
            };

            await newMcpServer.connect(newTransport);

            session = { mcpServer: newMcpServer, transport: newTransport };
          } catch (e) {
            // Handle errors during server creation
            logger.error('Error creating new MCP session:', e);
            if (!res.headersSent) {
              res.status(500).json({ error: 'Failed to create session' });
            }
            return;
          }
        } else {
          logger.error(
            'Bad Request: Missing session ID for non-initialize request.',
          );
          res.status(400).json({
            jsonrpc: '2.0',
            error: {
              code: -32000,
              message: 'Bad Request: Mcp-Session-Id header is required',
            },
            id: null,
          });
          return;
        }
      } else {
        logger.debug(
          this.debugMode,
          `Reusing transport and server for session: ${sessionId}`,
        );
      }

      try {
        await session.transport.handleRequest(req, res, req.body);
      } catch (e) {
        logger.error('Error handling request:', e);
        if (!res.headersSent) {
          res.status(500).end();
        }
      }
    });
  }

  private async registerAllGcliTools(mcpServer: McpServer) {
    const toolRegistry = await this.config.getToolRegistry();
    const allTools = toolRegistry.getAllTools();
    for (const tool of allTools) {
      this.registerGcliTool(tool, mcpServer);
    }
  }

  private registerGcliTool(tool: GcliTool, mcpServer: McpServer) {
    let toolInstanceForExecution = tool;

    // For web tools, check if a custom model is specified via environment variable.
    // If so, create a new tool instance with a proxied config to use that model.
    if (tool.name === 'google_web_search' || tool.name === 'web_fetch') {
      const toolModel = process.env.GEMINI_TOOLS_DEFAULT_MODEL;

      if (toolModel) {
        logger.debug(
          this.debugMode,
          `Using custom model "${toolModel}" for tool "${tool.name}"`,
        );

        // Create a proxy for this.config to override getModel.
        const proxyConfig = new Proxy(this.config, {
          get: (target, prop, receiver) => {
            if (prop === 'getModel') {
              return () => toolModel;
            }
            return Reflect.get(target, prop, receiver);
          },
        }) as Config;

        // Create a new tool instance with the proxied config.
        if (tool.name === 'google_web_search') {
          toolInstanceForExecution = new WebSearchTool(proxyConfig);
        } else {
          toolInstanceForExecution = new WebFetchTool(proxyConfig);
        }
      }
    }

    mcpServer.registerTool(
      tool.name,
      {
        title: tool.displayName,
        description: tool.description,
        inputSchema: this.convertJsonSchemaToZod(tool.schema.parameters),
      },
      async (
        args: Record<string, unknown>,
        extra: { signal: AbortSignal },
      ) => {
        const startTime = Date.now();
        logger.info('MCP tool call started', { toolName: tool.name, args });
        try {
          // toolInstanceForExecution is either the original tool or a new instance with a custom model config.
          const result = await toolInstanceForExecution.execute(
            args,
            extra.signal,
          );
          const durationMs = Date.now() - startTime;
          logger.info('MCP tool call finished', {
            toolName: tool.name,
            status: 'success',
            durationMs,
          });
          return this.convertGcliResultToMcpResult(result);
        } catch (e) {
          const durationMs = Date.now() - startTime;
          logger.error('MCP tool call failed', e as Error, {
            toolName: tool.name,
            durationMs,
          });
          // Re-throw the error to be handled by the MCP SDK.
          throw e;
        }
      },
    );
  }


  private convertJsonSchemaToZod(jsonSchema: any): any {
    // Helper to convert a single JSON schema property to a Zod type.
    // This is defined as an inner arrow function to recursively call itself for arrays
    // and to call the outer function for nested objects via `this`.
    const convertProperty = (prop: any): z.ZodTypeAny => {
      if (!prop || !prop.type) {
        return z.any();
      }

      switch (prop.type) {
        case 'string':
          return z.string().describe(prop.description || '');
        case 'number':
          return z.number().describe(prop.description || '');
        case 'boolean':
          return z.boolean().describe(prop.description || '');
        case 'array':
          // Recursively call the converter for `items`.
          if (!prop.items) {
            // A valid array schema MUST have `items`. Fallback to `any` if missing.
            return z.array(z.any()).describe(prop.description || '');
          }
          return z
            .array(convertProperty(prop.items))
            .describe(prop.description || '');
        case 'object':
          // For nested objects, recursively call the main function to get the shape.
          return z
            .object(this.convertJsonSchemaToZod(prop))
            .passthrough()
            .describe(prop.description || '');
        default:
          return z.any();
      }
    };

    if (!jsonSchema || !jsonSchema.properties) {
      return {};
    }

    const shape: any = {};
    for (const [key, prop] of Object.entries(jsonSchema.properties)) {
      let fieldSchema = convertProperty(prop as any);

      if (!jsonSchema.required || !jsonSchema.required.includes(key)) {
        fieldSchema = fieldSchema.optional();
      }
      shape[key] = fieldSchema;
    }
    return shape;
  }

  private convertGcliResultToMcpResult(
    gcliResult: ToolResult,
  ): CallToolResult {
    if (typeof gcliResult.llmContent === 'string') {
      return { content: [{ type: 'text', text: gcliResult.llmContent }] };
    }

    const parts = Array.isArray(gcliResult.llmContent)
      ? gcliResult.llmContent
      : [gcliResult.llmContent];

    const contentBlocks = parts.map((part: PartUnion) => {
      if (typeof part === 'string') {
        return { type: 'text' as const, text: part };
      }
      if ('text' in part && part.text) {
        return { type: 'text' as const, text: part.text };
      }
      return { type: 'text' as const, text: '[Unsupported Part Type]' };
    });

    return { content: contentBlocks };
  }
}
