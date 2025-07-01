import { GenerateContentResponse } from '@google/genai';

// 定义 OpenAI 流式响应的块结构
interface OpenAIDelta {
  role?: 'user' | 'assistant' | 'system';
  content?: string;
}

interface OpenAIChoice {
  index: number;
  delta: OpenAIDelta;
  finish_reason: string | null;
}

interface OpenAIChunk {
  id: string;
  object: 'chat.completion.chunk';
  created: number;
  model: string;
  choices: OpenAIChoice[];
}

/**
 * 创建一个 TransformStream，将 Gemini 的流式响应块转换为 OpenAI 兼容的 SSE 事件。
 * @param model - 正在使用的模型名称，用于填充 OpenAI 响应。
 * @returns 一个 TransformStream 实例。
 */
export function createOpenAIStreamTransformer(
  model: string,
): TransformStream<GenerateContentResponse, Uint8Array> {
  const chatID = `chatcmpl-${crypto.randomUUID()}`;
  const creationTime = Math.floor(Date.now() / 1000);
  const encoder = new TextEncoder();
  let isFirstChunk = true;

  return new TransformStream({
    transform(chunk, controller) {
      const text = chunk.candidates?.[0]?.content?.parts?.[0]?.text;
      if (!text) {
        return;
      }

      const delta: OpenAIDelta = { content: text };
      if (isFirstChunk) {
        delta.role = 'assistant';
        isFirstChunk = false;
      }

      const openAIChunk: OpenAIChunk = {
        id: chatID,
        object: 'chat.completion.chunk',
        created: creationTime,
        model: model,
        choices: [
          {
            index: 0,
            delta: delta,
            finish_reason: null,
          },
        ],
      };

      // 按照 SSE 格式编码
      const sseString = `data: ${JSON.stringify(openAIChunk)}\n\n`;
      controller.enqueue(encoder.encode(sseString));
    },
    flush(controller) {
      // 流结束时，发送 [DONE] 消息
      const doneString = `data: [DONE]\n\n`;
      controller.enqueue(encoder.encode(doneString));
    },
  });
}
