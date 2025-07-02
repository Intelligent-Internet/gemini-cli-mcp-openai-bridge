import { GenerateContentResponse } from '@google/genai';
import { randomUUID } from 'node:crypto';

// --- 更新的 OpenAI 响应结构接口 ---
interface OpenAIDelta {
  role?: 'assistant';
  content?: string | null;
  tool_calls?: {
    index: number;
    id: string;
    type: 'function';
    function: {
      name?: string;
      arguments?: string;
    };
  }[];
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

// --- 更新的转换器 ---
export function createOpenAIStreamTransformer(
  model: string,
): TransformStream<GenerateContentResponse, Uint8Array> {
  const chatID = `chatcmpl-${randomUUID()}`;
  const creationTime = Math.floor(Date.now() / 1000);
  const encoder = new TextEncoder();
  let isFirstChunk = true;

  return new TransformStream({
    transform(chunk, controller) {
      const parts = chunk.candidates?.[0]?.content?.parts || [];
      const finishReason = chunk.candidates?.[0]?.finishReason;

      let hasContent = false;

      for (const part of parts) {
        const delta: OpenAIDelta = {};

        if (isFirstChunk) {
          delta.role = 'assistant';
          isFirstChunk = false;
        }

        if (part.text) {
          delta.content = part.text;
          hasContent = true;
        }

        if (part.functionCall) {
          const fc = part.functionCall;
          const callId = `call_${randomUUID()}`; // 为每个调用生成一个唯一的ID

          // OpenAI的流式工具调用是分块的，我们这里简化为一次性发送
          // Gemini通常也是一次性返回一个完整的functionCall
          delta.tool_calls = [
            {
              index: 0, // 假设只有一个工具调用
              id: callId,
              type: 'function',
              function: {
                name: fc.name,
                arguments: JSON.stringify(fc.args), // 参数必须是字符串
              },
            },
          ];
          hasContent = true;
        }

        if (hasContent) {
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
          const sseString = `data: ${JSON.stringify(openAIChunk)}\n\n`;
          controller.enqueue(encoder.encode(sseString));
        }
      }

      // 如果有 finishReason，发送一个带有 finish_reason 的块
      if (
        finishReason &&
        finishReason !== 'FINISH_REASON_UNSPECIFIED' &&
        finishReason !== 'NOT_SET'
      ) {
        const finishDelta: OpenAIDelta = {};
        const openAIChunk: OpenAIChunk = {
          id: chatID,
          object: 'chat.completion.chunk',
          created: creationTime,
          model: model,
          choices: [
            {
              index: 0,
              delta: finishDelta,
              finish_reason: finishReason === 'STOP' ? 'stop' : 'tool_calls',
            },
          ],
        };
        const sseString = `data: ${JSON.stringify(openAIChunk)}\n\n`;
        controller.enqueue(encoder.encode(sseString));
      }
    },
    flush(controller) {
      // 流结束时，发送 [DONE] 消息
      const doneString = `data: [DONE]\n\n`;
      controller.enqueue(encoder.encode(doneString));
    },
  });
}
