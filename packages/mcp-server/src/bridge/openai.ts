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
      const geminiStream = client.sendMessageStream({
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
      if (!res.headersSent) {
        res.status(500).json({ error: errorMessage });
      } else {
        res.write(`data: ${JSON.stringify({ error: errorMessage })}\n\n`);
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
