import express, { Request, Response, NextFunction } from 'express';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';
import { type Config } from '../config/config.js';
import { type Tool as GcliTool, type ToolResult } from '../tools/tools.js';
import { type CallToolResult, isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import {
  type Part,
  type PartUnion,
  type PartListUnion,
  type Tool,
} from '@google/genai';
import { randomUUID } from 'node:crypto';
import { type GeminiRequest } from '../core/geminiRequest.js';

const LOG_PREFIX = '[MCP SERVER]';

// NEW: 日志中间件
const requestLogger = (req: Request, res: Response, next: NextFunction) => {
  console.log(`${LOG_PREFIX} ⬇️  Incoming Request: ${req.method} ${req.url}`);
  console.log(`${LOG_PREFIX}    Headers:`, JSON.stringify(req.headers, null, 2));
  if (req.body && Object.keys(req.body).length > 0) {
      const bodyStr = JSON.stringify(req.body);
      console.log(`${LOG_PREFIX}    Body:`, bodyStr.length > 300 ? bodyStr.substring(0, 300) + '...' : bodyStr);
  }
  next();
};

export class GcliMcpBridge {
  private readonly config: Config;
  private readonly cliVersion: string;
  private readonly mcpServer: McpServer;

  constructor(config: Config, cliVersion: string) {
    this.config = config;
    this.cliVersion = cliVersion;
    this.mcpServer = new McpServer(
      {
        name: 'gemini-cli-mcp-server',
        version: this.cliVersion,
      },
      { capabilities: { tools: { listChanged: true } } },
    );
  }

  public async start(port: number) {
    await this.registerAllGcliTools();

    const app = express();
    app.use(express.json());

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
            onsessioninitialized: (newSessionId) => {
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
        console.log(`${LOG_PREFIX}  reusing transport for session: ${sessionId}`);
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

    app.listen(port, () => {
      console.log(
        `${LOG_PREFIX} 🎧 MCP transport listening on http://localhost:${port}/mcp`,
      );
    });
  }

  private async registerAllGcliTools() {
    const toolRegistry = await this.config.getToolRegistry();
    const allTools = toolRegistry.getAllTools();
    for (const tool of allTools) {
      this.registerGcliTool(tool);
    }
    this.registerGeminiApiTool();
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
      async (args, extra) => {
        const result = await tool.execute(args, extra.signal);
        return this.convertGcliResultToMcpResult(result);
      },
    );
  }

  private registerGeminiApiTool() {
    this.mcpServer.registerTool(
      'call_gemini_api',
      {
        title: 'Gemini API Proxy',
        description:
          "Proxies a request to the Gemini API through the CLI's authenticated client. Allows dynamic provision of tools and a system prompt for this call.",
        inputSchema: {
          messages: z
            .any()
            .describe(
              'The conversation history or prompt to send to the Gemini API.',
            ),
          tools: z
            .array(z.any())
            .optional()
            .describe(
              'An array of tool definitions (FunctionDeclarations) to make available to the model for this call.',
            ),
          systemInstruction: z
            .string()
            .optional()
            .describe(
              "A system prompt to guide the model's behavior for this call.",
            ),
        },
      },
      async (args, { sendNotification, signal }) => {
        const { messages, tools, systemInstruction } = args as {
          messages: PartListUnion;
          tools?: Tool[];
          systemInstruction?: string;
        };

        const geminiClient = this.config.getGeminiClient();

        const request: GeminiRequest = {
          message: messages,
          config: {
            tools: tools,
            systemInstruction: systemInstruction,
          },
        };

        // Pass the dynamic tools and system prompt in the config for this specific call
        const stream = await geminiClient.sendMessageStream(
          request,
          signal, // Use the signal from the MCP request
        );

        let fullTextResponse = '';
        for await (const event of stream) {
          if (event.type === 'content' && event.value) {
            fullTextResponse += event.value;
            await sendNotification({
              method: 'notifications/message',
              params: { level: 'info', data: `[STREAM_CHUNK]${event.value}` },
            });
          }
          // Note: Tool call events from the proxied call are not currently forwarded.
          // This could be a future enhancement if needed.
        }

        return {
          content: [{ type: 'text', text: fullTextResponse }],
        };
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
