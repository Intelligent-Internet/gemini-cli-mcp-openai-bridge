import { randomUUID } from 'node:crypto';
import { type StreamChunk } from '../types.js';

// --- OpenAI 响应结构接口 ---
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

// --- 新的、有状态的转换器 ---
export function createOpenAIStreamTransformer(
  model: string,
): TransformStream<StreamChunk, Uint8Array> {
  const chatID = `chatcmpl-${randomUUID()}`;
  const creationTime = Math.floor(Date.now() / 1000);
  const encoder = new TextEncoder();
  let isFirstChunk = true;
  let toolCallIndex = 0;

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
    transform(chunk: StreamChunk, controller) {
      console.log(
        `[Stream Transformer] Received chunk: ${chunk.type}`,
        chunk.data ? JSON.stringify(chunk.data) : '',
      );
      let delta: OpenAIDelta = {};

      if (isFirstChunk) {
        delta.role = 'assistant';
        isFirstChunk = false;
      }

      switch (chunk.type) {
        case 'text':
          if (chunk.data) {
            delta.content = chunk.data;
            enqueueChunk(controller, createChunk(delta));
          }
          break;

        case 'tool_code': {
          const { name, args } = chunk.data;
          // **重要**: 在 ID 中嵌入函数名，以便在收到工具响应时可以解析它
          const toolCallId = `call_${name}_${randomUUID()}`;

          // OpenAI 流式工具调用需要分块发送
          // 1. 发送包含函数名的块
          const nameDelta: OpenAIDelta = {
            ...delta, // 包含 role (如果是第一个块)
            tool_calls: [
              {
                index: toolCallIndex,
                id: toolCallId,
                type: 'function',
                function: { name: name, arguments: '' },
              },
            ],
          };
          enqueueChunk(controller, createChunk(nameDelta));

          // 2. 发送包含参数的块
          const argsDelta: OpenAIDelta = {
            tool_calls: [
              {
                index: toolCallIndex,
                id: toolCallId,
                type: 'function',
                function: { arguments: JSON.stringify(args) },
              },
            ],
          };
          enqueueChunk(controller, createChunk(argsDelta));

          toolCallIndex++;
          break;
        }

        case 'reasoning':
          // 这些事件目前在 OpenAI 格式中没有直接对应项，可以选择忽略或以某种方式记录
          console.log(`[Stream Transformer] Ignoring chunk: ${chunk.type}`);
          break;
      }
    },

    flush(controller) {
      // 在流结束时，发送一个带有 `tool_calls` 或 `stop` 的 finish_reason
      const finish_reason = toolCallIndex > 0 ? 'tool_calls' : 'stop';
      enqueueChunk(controller, createChunk({}, finish_reason));

      const doneString = `data: [DONE]\n\n`;
      controller.enqueue(encoder.encode(doneString));
    },
  });
}
