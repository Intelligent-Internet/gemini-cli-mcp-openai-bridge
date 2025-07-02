import express, { Request, Response, NextFunction, Application } from 'express';
// [FIX] Correctly import 'Server' and 'JSONRPCError' from the SDK's server entry point.
import { Server, JSONRPCError } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';
import {
  type Config,
  type Tool as GcliTool,
  type ToolResult,
  GeminiChat,
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

const LOG_PREFIX = '[MCP SERVER]';

// NEW: 日志中间件
const requestLogger = (req: Request, res: Response, next: NextFunction) => {
  console.log(`${LOG_PREFIX} ⬇️  Incoming Request: ${req.method} ${req.url}`);
  console.log(`${LOG_PREFIX}    Headers:`, JSON.stringify(req.headers, null, 2));
  if (req.body && Object.keys(req.body).length > 0) {
    const bodyStr = JSON.stringify(req.body);
    console.log(
      `${LOG_PREFIX}    Body:`,
      bodyStr.length > 300 ? bodyStr.substring(0, 300) + '...' : bodyStr,
    );
  }
  next();
};

export class GcliMcpBridge {
  private readonly config: Config;
  private readonly cliVersion: string;
  // [FIX] Use the correct class name 'Server'
  private readonly mcpServer: Server;

  constructor(config: Config, cliVersion: string) {
    this.config = config;
    this.cliVersion = cliVersion;
    // [FIX] Instantiate the correct class 'Server'
    this.mcpServer = new Server(
      {
        name: 'gemini-cli-mcp-server',
        version: this.cliVersion,
      },
      { capabilities: { tools: { listChanged: true }, logging: {} } },
    );
  }

  public async start(app: Application) {
    await this.registerAllGcliTools();

    // NEW: 使用日志中间件
    app.use(requestLogger);

    const transports: Record<string, StreamableHTTPServerTransport> = {};

    app.all('/mcp', async (req: Request, res: Response) => {
      const sessionId = req.headers['mcp-session-id'] as string | undefined;
      let transport = sessionId ? transports[sessionId] : undefined;

      if (!transport) {
        if (isInitializeRequest(req.body)) {
          console.log(
            `${LOG_PREFIX} creating new transport for initialize request.`,
          );
          transport = new StreamableHTTPServerTransport({
            sessionIdGenerator: () => randomUUID(),
            onsessioninitialized: newSessionId => {
              console.log(
                `${LOG_PREFIX} ✅ Session initialized with ID: ${newSessionId}`,
              );
              transports[newSessionId] = transport!;
            },
          });

          transport.onclose = () => {
            const sid = transport!.sessionId;
            if (sid && transports[sid]) {
              console.log(
                `${LOG_PREFIX} 🚪 Transport for session ${sid} closed.`,
              );
              delete transports[sid];
            }
          };

          // Connect the new transport to the *existing* McpServer
          await this.mcpServer.connect(transport);
        } else {
          console.error(
            `${LOG_PREFIX} ❌ Bad Request: Missing or invalid session ID for non-initialize request.`,
          );
          res.status(400).json({
            jsonrpc: '2.0',
            error: {
              code: -32000,
              message: 'Bad Request: Missing or invalid session ID.',
            },
            id: null,
          });
          return;
        }
      } else {
        console.log(
          `${LOG_PREFIX}  reusing transport for session: ${sessionId}`,
        );
      }

      try {
        await transport.handleRequest(req, res, req.body);
      } catch (e) {
        console.error(`${LOG_PREFIX} 💥 Error handling request:`, e);
        if (!res.headersSent) {
          res.status(500).end();
        }
      }
    });
  }

  private async registerAllGcliTools() {
    const toolRegistry = await this.config.getToolRegistry();
    const allTools = toolRegistry.getAllTools();
    for (const tool of allTools) {
      this.registerGcliTool(tool);
    }
  }

  private registerGcliTool(tool: GcliTool) {
    const inputSchema = this.convertJsonSchemaToZod(tool.schema.parameters);

    this.mcpServer.registerTool(
      tool.name,
      {
        title: tool.displayName,
        description: tool.description,
        inputSchema: inputSchema,
      },
      // [FIX] Add explicit types for args and extra, and implement the try/catch block.
      async (
        args: Record<string, unknown>,
        extra: { signal: AbortSignal },
      ) => {
        try {
          const result = await tool.execute(args, extra.signal);
          return this.convertGcliResultToMcpResult(result);
        } catch (e) {
          const errorMessage = e instanceof Error ? e.message : String(e);
          console.error(
            `${LOG_PREFIX} 💥 Error executing tool '${tool.name}':`,
            errorMessage,
          );

          const userFacingMessage = `Error executing tool '${tool.name}': Quota exceeded. Do not retry. Upstream error: ${errorMessage}`;

          throw new JSONRPCError(
            -32000,
            userFacingMessage,
            {
              toolName: tool.name,
              originalError: errorMessage,
            },
          );
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
          // This is the key fix: recursively call the converter for `items`.
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

    // If no schema or properties, return an empty shape object.
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
    return shape; // Directly return the shape object.
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
