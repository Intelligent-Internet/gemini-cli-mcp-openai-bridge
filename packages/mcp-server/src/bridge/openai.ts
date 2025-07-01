import { Router, Request, Response } from 'express';
import { type Config, GeminiChat } from '@google/gemini-cli-core';
import { createOpenAIStreamTransformer } from './stream-transformer.js';
import { type Content } from '@google/genai';
import { WritableStream } from 'node:stream/web';
import { randomUUID } from 'node:crypto';

// 定义 OpenAI 请求体的接口
interface OpenAIChatCompletionRequest {
  model: string;
  messages: Array<{ role: string; content: string }>;
  stream?: boolean;
}

export function createOpenAIRouter(config: Config): Router {
  const router = Router();
  // 注意：基于 bridge.ts 的现有代码，我们假设 getGeminiClient 和 getContentGenerator 方法存在。
  const contentGenerator = config.getGeminiClient().getContentGenerator();

  // OpenAI chat completions 端点
  router.post(
    '/chat/completions',
    async (req: Request, res: Response) => {
      const body = req.body as OpenAIChatCompletionRequest;

      // 确保 stream 默认为 true，除非显式设置为 false
      const stream = body.stream !== false;

      if (!body.messages || body.messages.length === 0) {
        return res.status(400).json({ error: 'messages is required' });
      }

      // 将 OpenAI 格式的 messages 转换为 Gemini 格式
      // 注意：这里简化了处理，实际可能需要处理 system prompt 等
      const history: Content[] = body.messages.map(msg => ({
        role: msg.role === 'assistant' ? 'model' : 'user',
        parts: [{ text: msg.content }],
      }));

      const lastMessage = history.pop();
      if (!lastMessage) {
        return res.status(400).json({ error: 'No message to send.' });
      }

      try {
        const oneShotChat = new GeminiChat(
          config,
          contentGenerator,
          {}, // generationConfig
          history,
        );

        if (stream) {
          // --- 流式响应 ---
          res.setHeader('Content-Type', 'text/event-stream');
          res.setHeader('Cache-Control', 'no-cache');
          res.setHeader('Connection', 'keep-alive');
          res.flushHeaders(); // 立即发送头信息

          const geminiStream = await oneShotChat.sendMessageStream({
            message: lastMessage.parts,
          });
          const openAIStream = createOpenAIStreamTransformer(body.model);

          const writer = new WritableStream({
            write(chunk) {
              res.write(chunk);
            },
          });

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
        } else {
          // --- 非流式响应（为了完整性） ---
          const result = await oneShotChat.sendMessage({
            message: lastMessage.parts,
          });
          const responseText =
            result.candidates?.[0]?.content?.parts?.[0]?.text || '';

          res.json({
            id: `chatcmpl-${randomUUID()}`,
            object: 'chat.completion',
            created: Math.floor(Date.now() / 1000),
            model: body.model,
            choices: [
              {
                index: 0,
                message: {
                  role: 'assistant',
                  content: responseText,
                },
                finish_reason: 'stop',
              },
            ],
          });
        }
      } catch (error) {
        console.error('[OpenAI Bridge] Error:', error);
        const errorMessage =
          error instanceof Error ? error.message : 'An unknown error occurred';
        if (!res.headersSent) {
          res.status(500).json({ error: errorMessage });
        } else {
          // 如果头已发送，只能尝试写入错误信息并结束流
          res.write(`data: ${JSON.stringify({ error: errorMessage })}\n\n`);
          res.end();
        }
      }
    },
  );

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
