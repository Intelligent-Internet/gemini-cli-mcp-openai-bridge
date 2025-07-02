import express, { Request, Response, NextFunction, Application } from 'express';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';
import {
  type Config,
  type Tool as GcliTool,
  type ToolResult,
  GeminiChat,
  getResponseText,
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

// Simplified request logger - only log on debug mode
const requestLogger = (debugMode: boolean) => (req: Request, res: Response, next: NextFunction) => {
  if (debugMode) {
    console.log(`${LOG_PREFIX} ${req.method} ${req.url}`);
  }
  next();
};

export class GcliMcpBridge {
  private readonly config: Config;
  private readonly cliVersion: string;
  private readonly mcpServer: McpServer;
  private readonly debugMode: boolean;

  constructor(config: Config, cliVersion: string, debugMode = false) {
    this.config = config;
    this.cliVersion = cliVersion;
    this.debugMode = debugMode;
    this.mcpServer = new McpServer(
      {
        name: 'gemini-cli-mcp-server',
        version: this.cliVersion,
      },
      { capabilities: { tools: { listChanged: true }, logging: {} } },
    );
  }

  public async start(app: Application) {
    await this.registerAllGcliTools();

    // Only use request logger in debug mode
    if (this.debugMode) {
      app.use(requestLogger(this.debugMode));
    }

    const transports: Record<string, StreamableHTTPServerTransport> = {};

    app.all('/mcp', async (req: Request, res: Response) => {
      const sessionId = req.headers['mcp-session-id'] as string | undefined;
      let transport = sessionId ? transports[sessionId] : undefined;

      if (!transport) {
        if (isInitializeRequest(req.body)) {
          if (this.debugMode) {
            console.log(
              `${LOG_PREFIX} Creating new transport for initialize request`,
            );
          }
          transport = new StreamableHTTPServerTransport({
            sessionIdGenerator: () => randomUUID(),
            onsessioninitialized: newSessionId => {
              if (this.debugMode) {
                console.log(
                  `${LOG_PREFIX} Session initialized: ${newSessionId}`,
                );
              }
              transports[newSessionId] = transport!;
            },
          });

          transport.onclose = () => {
            const sid = transport!.sessionId;
            if (sid && transports[sid]) {
              if (this.debugMode) {
                console.log(
                  `${LOG_PREFIX} Session ${sid} closed`,
                );
              }
              delete transports[sid];
            }
          };

          // Connect the new transport to the *existing* McpServer
          await this.mcpServer.connect(transport);
        } else {
          console.error(
            `${LOG_PREFIX} Bad Request: Missing or invalid session ID`,
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
      } else if (this.debugMode) {
        console.log(
          `${LOG_PREFIX} Reusing transport for session: ${sessionId}`,
        );
      }

      try {
        await transport.handleRequest(req, res, req.body);
      } catch (e) {
        console.error(`${LOG_PREFIX} Error handling request:`, e);
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
      async (
        args: Record<string, unknown>,
        extra: { signal: AbortSignal },
      ) => {
        try {
          // --- START: Isolation logic for tools that call the LLM ---
          if (tool.name === 'google_web_search' || tool.name === 'web_fetch') {
            // Create an isolated, one-shot chat session for this call
            const oneShotChat = new GeminiChat(
              this.config,
              this.config.getGeminiClient().getContentGenerator(),
              {}, // Use default generationConfig
              [], // Start with a clean history
            );

            // Prepare the request for the Gemini API
            const request = {
              message: [{ text: args.query as string }],
              config: {
                tools: [{ googleSearch: {} }], // For web_search
              },
            };

            // Adjust tool config for web_fetch
            if (tool.name === 'web_fetch') {
              // web_fetch uses a different tool configuration
              request.config.tools = [{ urlContext: {} }];
            }

            // Send the request using the one-shot session
            const response = await oneShotChat.sendMessage(request);
            const resultText = getResponseText(response) || '';

            // Convert the result to the MCP format
            const mcpResult = this.convertGcliResultToMcpResult({
              llmContent: resultText,
              returnDisplay: `Search results for "${args.query}" returned.`,
            });

            // Attach grounding metadata if it exists
            if (response.candidates?.[0]?.groundingMetadata) {
              (mcpResult as any)._meta = {
                groundingMetadata: response.candidates[0].groundingMetadata,
              };
            }

            return mcpResult;
          }
          // --- END: Isolation logic ---

          // For other tools that don't call the LLM, use the original execute method
          const result = await tool.execute(args, extra.signal);
          return this.convertGcliResultToMcpResult(result);
        } catch (e) {
          const errorMessage = e instanceof Error ? e.message : String(e);
          console.error(
            `${LOG_PREFIX} Error executing tool '${tool.name}': ${errorMessage}`,
          );

          // Simply throw an Error, and the MCP SDK will automatically handle it
          // as an appropriate JSON-RPC error.
          throw new Error(
            `Error executing tool '${tool.name}': ${errorMessage}`,
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
