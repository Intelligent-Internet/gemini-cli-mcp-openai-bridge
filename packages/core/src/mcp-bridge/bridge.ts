import express from 'express';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';
import { type Config } from '../config/config.js';
import { type Tool, type ToolResult } from '../tools/tools.js';
import { type CallToolResult } from '@modelcontextprotocol/sdk/types.js';
// import { FunctionDeclarationSchema } from '@google/genai'; // 假设这个类型可以从 genai SDK 导入

export class GcliMcpBridge {
  private readonly mcpServer: McpServer;
  private readonly config: Config;

  constructor(config: Config) {
    this.config = config;
    this.mcpServer = new McpServer(
      {
        name: 'gemini-cli-mcp-server',
        // 调用我们即将添加的新方法
        version: this.config.getCliVersion(),
      },
      {
        capabilities: { tools: {} },
      },
    );
  }

  public async start(port: number) {
    await this.registerAllGcliTools();

    const app = express();
    app.use(express.json());

    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined, // Stateless mode
    });

    await this.mcpServer.connect(transport);

    app.all('/mcp', (req, res) => {
      transport.handleRequest(req, res, req.body);
    });

    app.listen(port, () => {
      console.log(`MCP transport listening on http://localhost:${port}/mcp`);
    });
  }

  private async registerAllGcliTools() {
    // 调用我们即将添加的新方法
    const toolRegistry = await this.config.getToolRegistry();
    const allTools = await toolRegistry.getAllTools();

    // 注册普通工具
    for (const tool of allTools) {
      this.registerGcliTool(tool);
    }

    // 注册特殊的 LLM 代理工具
    this.registerGeminiApiTool();
  }

  private registerGcliTool(tool: Tool) {
    // 这里需要一个健壮的转换器
    const inputSchema = this.convertJsonSchemaToZod(tool.schema.parameters);

    this.mcpServer.registerTool(
      tool.name,
      {
        title: tool.displayName,
        description: tool.description,
        inputSchema: inputSchema,
      },
      async (args, extra) => {
        // 注意：GCLI 的工具执行可能需要 AbortSignal，我们需要从 extra 中获取
        const result = await tool.execute(args, extra.signal);
        return this.convertGcliResultToMcpResult(result);
      },
    );
  }

  private registerGeminiApiTool() {
    // ... (与原方案中的实现相同) ...
    this.mcpServer.registerTool(
      'call_gemini_api',
      {
        title: 'Gemini API Proxy',
        description:
          "Proxies a request to the Gemini API through the CLI's authenticated client.",
        inputSchema: z.object({
          messages: z.any(),
          // ... 其他 LLM 参数
        }),
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
    if (!jsonSchema || !jsonSchema.properties) {
      return z.object({});
    }
    const shape: any = {};
    for (const [key, prop] of Object.entries(jsonSchema.properties)) {
      switch ((prop as any).type) {
        case 'string':
          shape[key] = z.string().describe((prop as any).description || '');
          break;
        case 'number':
          shape[key] = z.number().describe((prop as any).description || '');
          break;
        case 'boolean':
          shape[key] = z.boolean().describe((prop as any).description || '');
          break;
        // 添加对 array 和 object 的基本支持
        case 'array':
          shape[key] = z.array(z.any()).describe((prop as any).description || '');
          break;
        case 'object':
          shape[key] = z
            .object({})
            .passthrough()
            .describe((prop as any).description || '');
          break;
        default:
          shape[key] = z.any();
      }
      if (!jsonSchema.required || !jsonSchema.required.includes(key)) {
        shape[key] = shape[key].optional();
      }
    }
    return z.object(shape);
  }

  private convertGcliResultToMcpResult(
    gcliResult: ToolResult,
  ): CallToolResult {
    if (typeof gcliResult.llmContent === 'string') {
      return { content: [{ type: 'text', text: gcliResult.llmContent }] };
    }

    // PartListUnion -> ContentBlock[]
    const contentBlocks = gcliResult.llmContent.map((part) => {
      if ('text' in part && part.text) {
        return { type: 'text' as const, text: part.text };
      }
      // 需要更详细的转换逻辑来处理其他 Part 类型
      return { type: 'text' as const, text: '[Unsupported Part Type]' };
    });

    return { content: contentBlocks };
  }
}
