import express, { Request, Response, NextFunction, Application } from 'express';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';
import {
  type Config,
  type Tool as GcliTool,
  type ToolResult,
  GeminiChat,
  WebFetchTool, // <--- 添加这个导入
  WebSearchTool, // <--- 添加这个导入
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

const requestLogger = (debugMode: boolean) => (req: Request, res: Response, next: NextFunction) => {
  if (debugMode) {
    console.log(`${LOG_PREFIX} ${req.method} ${req.url}`);
  }
  next();
};

export class GcliMcpBridge {
  private readonly config: Config;
  private readonly cliVersion: string;
  private readonly debugMode: boolean;
  // **修改 2: 更新 transports 的类型以存储每个会话的 McpServer 和 Transport**
  private readonly sessions: Record<
    string,
    { mcpServer: McpServer; transport: StreamableHTTPServerTransport }
  > = {};

  constructor(config: Config, cliVersion: string, debugMode = false) {
    this.config = config;
    this.cliVersion = cliVersion;
    this.debugMode = debugMode;
  }

  // **辅助方法：创建一个新的 McpServer 实例**
  private async createNewMcpServer(): Promise<McpServer> {
    const server = new McpServer(
      {
        name: 'gemini-cli-mcp-server',
        version: this.cliVersion,
      },
      { capabilities: { logging: {} } },
    );
    // 在这里立即注册所有工具
    await this.registerAllGcliTools(server);
    return server;
  }

  public async start(app: Application) {

    if (this.debugMode) {
      app.use(requestLogger(this.debugMode));
    }

    app.all('/mcp', async (req: Request, res: Response) => {
      const sessionId = req.headers['mcp-session-id'] as string | undefined;

      // **修改 5: 从 `sessions` map 中获取会话对象**
      let session = sessionId ? this.sessions[sessionId] : undefined;

      if (!session) {
        if (isInitializeRequest(req.body)) {
          if (this.debugMode) {
            console.log(
              `${LOG_PREFIX} Creating new session and transport for initialize request`,
            );
          }

          try {
            // **修改 6: 为新会话创建独立的 McpServer 和 Transport**
            const newMcpServer = await this.createNewMcpServer();
            const newTransport = new StreamableHTTPServerTransport({
              sessionIdGenerator: () => randomUUID(),
              onsessioninitialized: (newSessionId) => {
                if (this.debugMode) {
                  console.log(
                    `${LOG_PREFIX} Session initialized: ${newSessionId}`,
                  );
                }
                // 存储新的会话对象
                this.sessions[newSessionId] = {
                  mcpServer: newMcpServer,
                  transport: newTransport,
                };
              },
            });

            newTransport.onclose = () => {
              const sid = newTransport.sessionId;
              if (sid && this.sessions[sid]) {
                if (this.debugMode) {
                  console.log(
                    `${LOG_PREFIX} Session ${sid} closed, removing session object.`,
                  );
                }
                delete this.sessions[sid];
              }
            };

            // 将新的 transport 连接到新的 McpServer 实例
            await newMcpServer.connect(newTransport);

            session = { mcpServer: newMcpServer, transport: newTransport };
          } catch (e) {
            // Handle errors during server creation
            console.error(`${LOG_PREFIX} Error creating new MCP session:`, e);
            if (!res.headersSent) {
              res.status(500).json({ error: 'Failed to create session' });
            }
            return;
          }
        } else {
          console.error(
            `${LOG_PREFIX} Bad Request: Missing session ID for non-initialize request.`,
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
      } else if (this.debugMode) {
        console.log(
          `${LOG_PREFIX} Reusing transport and server for session: ${sessionId}`,
        );
      }

      try {
        // **修改 7: 使用会话特定的 transport 来处理请求**
        await session.transport.handleRequest(req, res, req.body);
      } catch (e) {
        console.error(`${LOG_PREFIX} Error handling request:`, e);
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
    let toolInstanceForExecution = tool; // 默认使用从 ToolRegistry 传入的原始工具实例

    // 检查是否是需要特殊处理的网页工具
    if (tool.name === 'google_web_search' || tool.name === 'web_fetch') {
      const toolModel = process.env.GEMINI_TOOLS_DEFAULT_MODEL;

      // 如果为这些工具设置了专用的模型，则创建一个新的配置和工具实例
      if (toolModel) {
        if (this.debugMode) {
          console.log(
            `[MCP SERVER] Using custom model "${toolModel}" for tool "${tool.name}"`,
          );
        }

        // 步骤 1: 创建一个 this.config 的代理。
        // 这个代理对象会拦截对 getModel 方法的调用。
        const proxyConfig = new Proxy(this.config, {
          get: (target, prop, receiver) => {
            // 如果调用的方法是 getModel，则返回我们指定的工具模型
            if (prop === 'getModel') {
              return () => toolModel;
            }
            // 对于所有其他属性和方法的调用，都代理到原始的 config 对象
            return Reflect.get(target, prop, receiver);
          },
        }) as Config;

        // 步骤 2: 根据工具名称，使用这个代理配置来创建新的工具实例
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
        try {
          // *** 关键：现在所有工具都通过这个统一的路径执行 ***
          // toolInstanceForExecution 要么是原始工具，要么是带有自定义模型配置的新实例
          const result = await toolInstanceForExecution.execute(
            args,
            extra.signal,
          );
          return this.convertGcliResultToMcpResult(result);
        } catch (e) {
          const errorMessage = e instanceof Error ? e.message : String(e);
          console.error(
            `${LOG_PREFIX} Error executing tool '${tool.name}': ${errorMessage}`,
          );
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
