import { Router, Request, Response } from 'express';
import { type Config } from '@google/gemini-cli-core';
import { createOpenAIStreamTransformer } from './stream-transformer.js';
import { WritableStream } from 'node:stream/web';
import { GeminiApiClient } from '../gemini-client.js'; // <-- 引入新类
import { type OpenAIChatCompletionRequest } from '../types.js'; // <-- 引入新类型

export function createOpenAIRouter(config: Config): Router {
  const router = Router();

  router.post('/chat/completions', async (req: Request, res: Response) => {
    try {
      const body = req.body as OpenAIChatCompletionRequest;
      console.log(
        '[OpenAI Bridge] Received /chat/completions request:',
        JSON.stringify(body, null, 2),
      );
      const stream = body.stream !== false;

      if (!stream) {
        // 非流式响应逻辑可以稍后实现，或直接返回错误
        res
          .status(501)
          .json({ error: 'Non-streaming responses are not yet implemented.' });
        return;
      }

      // --- 流式响应 ---
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');
      res.flushHeaders();

      // 1. 使用新的 GeminiApiClient
      const client = new GeminiApiClient(config);

      // 2. 发起请求，传递所有相关参数
      const geminiStream = await client.sendMessageStream({
        model: body.model,
        messages: body.messages,
        tools: body.tools,
        tool_choice: body.tool_choice,
      });

      // 3. 创建转换器和写入器
      const openAIStream = createOpenAIStreamTransformer(body.model);
      const writer = new WritableStream({
        write(chunk) {
          res.write(chunk);
        },
      });

      // 4. 创建 ReadableStream 并通过管道连接
      const readableStream = new ReadableStream({
        async start(controller) {
          for await (const value of geminiStream) {
            controller.enqueue(value);
          }
          controller.close();
        },
      });

      await readableStream.pipeThrough(openAIStream).pipeTo(writer);
      res.end();
    } catch (error) {
      console.error('[OpenAI Bridge] Error:', error);
      const errorMessage =
        error instanceof Error ? error.message : 'An unknown error occurred';

      // [MODIFICATION] 检查错误类型并设置适当的状态码
      let statusCode = 500; // 默认为内部服务器错误
      if (error instanceof Error) {
        // 检查 gaxios 或类似 HTTP 客户端可能附加的 status 属性
        const status = (error as any).status;
        if (status === 429) {
          statusCode = 429;
        } else if (typeof status === 'number' && status >= 400 && status < 500) {
          statusCode = status;
        }
        // 也可以通过检查消息内容来增加健壮性
        else if (
          errorMessage.includes('429') ||
          errorMessage.toLowerCase().includes('quota')
        ) {
          statusCode = 429;
        }
      }

      if (!res.headersSent) {
        // 使用动态的状态码
        res.status(statusCode).json({
          error: {
            message: errorMessage,
            type: 'gemini_api_error',
            code: statusCode, // 在响应体中也反映出来
          },
        });
      } else {
        // 如果流已经开始，我们无法改变状态码，但可以在流中发送错误
        res.write(
          `data: ${JSON.stringify({ error: errorMessage, code: statusCode })}\n\n`,
        );
        res.end();
      }
    }
  });

  // 可以添加 /v1/models 端点
  router.get('/models', (req, res) => {
    // 这里可以返回一个固定的模型列表，或者从 config 中获取
    res.json({
      object: 'list',
      data: [
        { id: 'gemini-1.5-pro-latest', object: 'model', owned_by: 'google' },
        { id: 'gemini-1.5-flash-latest', object: 'model', owned_by: 'google' },
        { id: 'gemini-pro', object: 'model', owned_by: 'google' },
      ],
    });
  });

  return router;
}
