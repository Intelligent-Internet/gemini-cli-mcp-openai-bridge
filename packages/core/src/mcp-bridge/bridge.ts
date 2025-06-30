import express, { Request, Response, NextFunction } from 'express';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';
import { type Config } from '../config/config.js';
import { type Tool, type ToolResult } from '../tools/tools.js';
import { type CallToolResult, isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import { type Part, type PartUnion } from '@google/genai';
import { randomUUID } from 'node:crypto';

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

  private registerGcliTool(tool: Tool) {
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
          "Proxies a request to the Gemini API through the CLI's authenticated client.",
        inputSchema: {
          messages: z.any(),
        },
      },
      async (args, { sendNotification }) => {
        const geminiClient = this.config.getGeminiClient();
        const stream = await geminiClient.sendMessageStream(
          (args as { messages: any }).messages,
          new AbortController().signal,
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
        }

        return {
          content: [{ type: 'text', text: fullTextResponse }],
        };
      },
    );
  }
  
  private convertJsonSchemaToZod(jsonSchema: any): any {
    // 如果没有 schema 或 properties，返回一个空的 shape 对象
    if (!jsonSchema || !jsonSchema.properties) {
      return {};
    }

    const shape: any = {};
    for (const [key, prop] of Object.entries(jsonSchema.properties)) {
      let fieldSchema: z.ZodTypeAny;

      switch ((prop as any).type) {
        case 'string':
          fieldSchema = z.string().describe((prop as any).description || '');
          break;
        case 'number':
          fieldSchema = z.number().describe((prop as any).description || '');
          break;
        case 'boolean':
          fieldSchema = z.boolean().describe((prop as any).description || '');
          break;
        case 'array':
          fieldSchema = z.array(z.any()).describe((prop as any).description || '');
          break;
        case 'object':
          fieldSchema = z
            .object({})
            .passthrough()
            .describe((prop as any).description || '');
          break;
        default:
          fieldSchema = z.any();
      }

      if (!jsonSchema.required || !jsonSchema.required.includes(key)) {
        shape[key] = fieldSchema.optional();
      } else {
        shape[key] = fieldSchema;
      }
    }
    return shape; // 直接返回 shape 对象
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
