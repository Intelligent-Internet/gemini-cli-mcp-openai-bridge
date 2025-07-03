import { Router, Request, Response } from 'express';
import { type Config } from '@google/gemini-cli-core';
import { createOpenAIStreamTransformer } from './stream-transformer.js';
import { GeminiApiClient } from '../gemini-client.js';
import { type OpenAIChatCompletionRequest } from '../types.js';
import { mapErrorToOpenAIError } from '../utils/error-mapper.js';
import { logger } from '../utils/logger.js';
import { randomUUID } from 'node:crypto';

export function createOpenAIRouter(config: Config, debugMode = false): Router {
  const router = Router();

  // Middleware: Add a requestId to each request.
  router.use((req, res, next) => {
    (req as any).requestId = randomUUID();
    next();
  });

  router.post('/chat/completions', async (req: Request, res: Response) => {
    const requestId = (req as any).requestId;
    const startTime = Date.now();
    try {
      const body = req.body as OpenAIChatCompletionRequest;

      logger.info('OpenAI bridge request received', {
        requestId,
        model: body.model,
        stream: body.stream,
      });
      logger.debug(debugMode, 'Request body:', { requestId, body });
      const stream = body.stream !== false;

      if (!stream) {
        // Non-streaming responses are not yet implemented.
        res
          .status(501)
          .json({ error: 'Non-streaming responses are not yet implemented.' });
        return;
      }

      // --- Streaming Response ---
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');
      res.flushHeaders();

      const client = new GeminiApiClient(config, debugMode);

      const geminiStream = await client.sendMessageStream({
        model: body.model,
        messages: body.messages,
        tools: body.tools,
        tool_choice: body.tool_choice,
      });

      const openAIStream = createOpenAIStreamTransformer(body.model, debugMode);

      // --- Core streaming logic ---
      // Create a ReadableStream to wrap our Gemini event stream.
      const readableStream = new ReadableStream({
        async start(controller) {
          for await (const value of geminiStream) {
            controller.enqueue(value);
          }
          controller.close();
        },
      });

      // Pipe our stream through the transformer.
      const transformedStream = readableStream.pipeThrough(openAIStream);
      const reader = transformedStream.getReader();

      // Manually read each transformed chunk and write it to the response immediately.
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
      // --- End of core streaming logic ---

      const durationMs = Date.now() - startTime;
      logger.info('OpenAI bridge request finished', {
        requestId,
        status: 'success',
        durationMs,
      });
      res.end();
    } catch (e: unknown) {
      const durationMs = Date.now() - startTime;
      logger.error('OpenAI bridge request failed', e as Error, {
        requestId,
        durationMs,
      });

      // 调用新的错误映射函数
      const { openAIError, statusCode } = mapErrorToOpenAIError(e);

      if (!res.headersSent) {
        res.status(statusCode).json(openAIError);
      } else {
        // If headers are already sent, we can't change the status code,
        // but we can send an error in the stream.
        res.write(`data: ${JSON.stringify({ error: openAIError.error })}\n\n`);
        res.end();
      }
    }
  });

  // The /v1/models endpoint can be added here.
  router.get('/models', (req, res) => {
    // This can return a fixed list of models or get them from the config.
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
