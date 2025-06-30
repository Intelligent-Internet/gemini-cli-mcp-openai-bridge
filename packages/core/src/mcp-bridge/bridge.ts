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
  type GenerateContentConfig,
  type GenerateContentResponse,
  type Content,
} from '@google/genai';
import { randomUUID } from 'node:crypto';
import { GeminiChat } from '../core/geminiChat.js';

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
      { capabilities: { tools: { listChanged: true }, logging: {} } },
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
          messages: Content[];
          tools?: Tool[];
          systemInstruction?: string;
        };

        const contentGenerator = this.config
          .getGeminiClient()
          .getContentGenerator();

        // 1. Prepare the generation config with dynamic tools and system prompt.
        const generationConfig: GenerateContentConfig = {
          tools: tools,
          systemInstruction: systemInstruction,
        };

        // The history for the one-shot chat is all messages except the last one.
        const history = messages.slice(0, -1);
        // The new prompt is the parts from the last message.
        const lastMessage = messages[messages.length - 1];
        const newPrompt = lastMessage?.parts;

        if (!newPrompt) {
          // This should ideally return a proper JSON-RPC error.
          // For now, we'll let it proceed, which will likely fail downstream
          // in sendMessageStream if `newPrompt` is undefined.
          console.error(
            `${LOG_PREFIX} ❌ Invalid 'call_gemini_api' arguments: 'messages' array is empty or last message has no parts.`,
          );
        }

        // 2. Create a new, stateless GeminiChat instance for this single call.
        const oneShotChat = new GeminiChat(
          this.config,
          contentGenerator,
          generationConfig, // Pass dynamic config here
          history, // Start with the provided history
        );

        // 3. Call sendMessageStream on the new instance.
        const stream = await oneShotChat.sendMessageStream({
          message: newPrompt || [], // Pass only the parts of the new message
        });

        let fullTextResponse = '';
        for await (const event of stream) {
          if (signal.aborted) {
            console.log(`${LOG_PREFIX} 🛑 Request was aborted by the client.`);
            break;
          }
          let chunkText = '';
          if (event.candidates && event.candidates.length > 0) {
            const parts = event.candidates[0].content?.parts || [];
            for (const part of parts) {
              if (part.text) {
                chunkText += part.text;
              }
            }
          }

          if (chunkText) {
            fullTextResponse += chunkText;
            await sendNotification({
              method: 'notifications/message',
              params: { level: 'info', data: `[STREAM_CHUNK]${chunkText}` },
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
