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

interface OpenAIChunk {
  id: string;
  object: 'chat.completion.chunk';
  created: number;
  model: string;
  choices: {
    index: number;
    delta: OpenAIDelta;
    finish_reason: string | null;
  }[];
}

type ToolCallState = {
  id: string;
  name: string;
  arguments: string;
};

// --- 更新的、有状态的转换器 ---
export function createOpenAIStreamTransformer(
  model: string,
): TransformStream<GenerateContentResponse, Uint8Array> {
  const chatID = `chatcmpl-${randomUUID()}`;
  const creationTime = Math.floor(Date.now() / 1000);
  const encoder = new TextEncoder();
  let isFirstChunk = true;
  const toolCallStates: ToolCallState[] = [];

  const createChunk = (
    delta: OpenAIDelta,
    finish_reason: string | null = null,
  ): OpenAIChunk => ({
    id: chatID,
    object: 'chat.completion.chunk',
    created: creationTime,
    model: model,
    choices: [
      {
        index: 0,
        delta,
        finish_reason,
      },
    ],
  });

  const enqueueChunk = (
    controller: TransformStreamDefaultController<Uint8Array>,
    chunk: OpenAIChunk,
  ) => {
    const sseString = `data: ${JSON.stringify(chunk)}\n\n`;
    controller.enqueue(encoder.encode(sseString));
  };

  return new TransformStream({
    transform(geminiChunk, controller) {
      const parts = geminiChunk.candidates?.[0]?.content?.parts || [];
      const finishReason = geminiChunk.candidates?.[0]?.finishReason;

      for (const part of parts) {
        let delta: OpenAIDelta = {};

        if (isFirstChunk) {
          delta.role = 'assistant';
          isFirstChunk = false;
        }

        if (part.text) {
          delta.content = part.text;
          enqueueChunk(controller, createChunk(delta));
        }

        if (part.functionCall) {
          const fc = part.functionCall;
          const callId = `call_${randomUUID()}`;

          // 模拟分块发送 tool_calls
          // 1. 发送带有 name 的块
          const nameDelta: OpenAIDelta = {
            tool_calls: [
              {
                index: toolCallStates.length,
                id: callId,
                type: 'function',
                function: { name: fc.name, arguments: '' },
              },
            ],
          };
          if (isFirstChunk) {
            nameDelta.role = 'assistant';
            isFirstChunk = false;
          }
          enqueueChunk(controller, createChunk(nameDelta));

          // 2. 发送带有 arguments 的块
          const argsDelta: OpenAIDelta = {
            tool_calls: [
              {
                index: toolCallStates.length,
                id: callId,
                type: 'function',
                function: { arguments: JSON.stringify(fc.args) },
              },
            ],
          };
          enqueueChunk(controller, createChunk(argsDelta));

          toolCallStates.push({
            id: callId,
            name: fc.name,
            arguments: JSON.stringify(fc.args),
          });
        }
      }

      if (
        finishReason &&
        finishReason !== 'FINISH_REASON_UNSPECIFIED' &&
        finishReason !== 'NOT_SET'
      ) {
        const reason =
          finishReason === 'STOP'
            ? 'stop'
            : finishReason === 'TOOL_CALL'
              ? 'tool_calls'
              : finishReason.toLowerCase();
        enqueueChunk(controller, createChunk({}, reason));
      }
    },
    flush(controller) {
      const doneString = `data: [DONE]\n\n`;
      controller.enqueue(encoder.encode(doneString));
    },
  });
}
