import { Router, Request, Response } from 'express';
import { type Config } from '@google/gemini-cli-core';
import { createOpenAIStreamTransformer } from './stream-transformer.js';
import { GeminiApiClient } from '../gemini-client.js'; // <-- 引入新类
import { type OpenAIChatCompletionRequest } from '../types.js'; // <-- 引入新类型
import { mapErrorToOpenAIError } from '../utils/error-mapper.js';

export function createOpenAIRouter(config: Config, debugMode = false): Router {
  const router = Router();

  router.post('/chat/completions', async (req: Request, res: Response) => {
    try {
      const body = req.body as OpenAIChatCompletionRequest;
      if (debugMode) {
        console.log(
          '[OpenAI Bridge] Received /chat/completions request:',
          JSON.stringify(body, null, 2),
        );
      }
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
      const client = new GeminiApiClient(config, debugMode);

      // 2. 发起请求，传递所有相关参数
      const geminiStream = await client.sendMessageStream({
        model: body.model,
        messages: body.messages,
        tools: body.tools,
        tool_choice: body.tool_choice,
      });

      const openAIStream = createOpenAIStreamTransformer(body.model, debugMode);

      // --- 修正的核心逻辑 ---
      // 1. 创建一个 ReadableStream 来包装我们的 Gemini 事件流
      const readableStream = new ReadableStream({
        async start(controller) {
          for await (const value of geminiStream) {
            controller.enqueue(value);
          }
          controller.close();
        },
      });

      // 2. 将我们的流通过转换器
      const transformedStream = readableStream.pipeThrough(openAIStream);
      const reader = transformedStream.getReader();

      // 3. 手动读取每个转换后的块并立即写入响应
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) {
            break;
          }
          res.write(value);
        }
      } finally {
        reader.releaseLock();
      }
      // --- 修正结束 ---

      res.end();
    } catch (e: unknown) {
      console.error('[OpenAI Bridge] Error:', e);

      // 调用新的错误映射函数
      const { openAIError, statusCode } = mapErrorToOpenAIError(e);

      // 使用映射后的状态码和错误对象进行响应
      if (!res.headersSent) {
        res.status(statusCode).json(openAIError);
      } else {
        // 如果流已经开始，我们无法改变状态码，但可以在流中发送错误
        res.write(`data: ${JSON.stringify({ error: openAIError.error })}\n\n`);
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
        { id: 'gemini-2.5-pro', object: 'model', owned_by: 'google' },
        { id: 'gemini-2.5-flash', object: 'model', owned_by: 'google' },
      ],
    });
  });

  return router;
}
