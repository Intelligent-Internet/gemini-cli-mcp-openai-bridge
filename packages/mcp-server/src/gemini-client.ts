/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { type Config, GeminiChat } from '@google/gemini-cli-core';
import { type Content, type Part, type Tool } from '@google/genai';
import { type OpenAIMessage, type MessageContentPart } from './types.js';

export class GeminiApiClient {
  private readonly config: Config;
  private readonly contentGenerator;

  constructor(config: Config) {
    this.config = config;
    this.contentGenerator = this.config.getGeminiClient().getContentGenerator();
  }

  /**
   * 将 OpenAI 格式的消息转换为 Gemini 格式的 Content 对象。
   * 这个函数现在能处理文本和图片（多模态）输入。
   */
  private openAIMessageToGemini(msg: OpenAIMessage): Content {
    const role = msg.role === 'assistant' ? 'model' : 'user';

    if (typeof msg.content === 'string') {
      return { role, parts: [{ text: msg.content }] };
    }

    if (Array.isArray(msg.content)) {
      const parts: Part[] = msg.content
        .map((part: MessageContentPart) => {
          if (part.type === 'text') {
            return { text: part.text || '' };
          }
          if (part.type === 'image_url' && part.image_url) {
            const imageUrl = part.image_url.url;
            if (imageUrl.startsWith('data:')) {
              const [mimePart, dataPart] = imageUrl.split(',');
              const mimeType = mimePart.split(':')[1].split(';')[0];
              return { inlineData: { mimeType, data: dataPart } };
            }
            // Gemini API 可能不支持直接传递 URL，但我们先按协议转换
            return { fileData: { mimeType: 'image/jpeg', fileUri: imageUrl } };
          }
          // 对于不支持的 part 类型，返回一个空文本 part
          return { text: '' };
        })
        .filter((p) => p.text !== '' || p.inlineData || p.fileData); // 过滤掉完全空的 part

      return { role, parts };
    }

    // 针对 tool role 的转换
    if (msg.role === 'tool' && msg.tool_call_id && msg.content) {
      return {
        role: 'user', // Gemini 使用 'user' role 来承载 functionResponse
        parts: [
          {
            functionResponse: {
              name: msg.tool_call_id, // 这里的映射关系需要确认，通常是工具名
              response: { content: msg.content },
            },
          },
        ],
      };
    }

    return { role, parts: [{ text: '' }] };
  }

  /**
   * 发起流式请求到 Gemini API
   */
  public async sendMessageStream({
    model,
    messages,
    tools,
    tool_choice,
  }: {
    model: string;
    messages: OpenAIMessage[];
    tools?: Tool[];
    tool_choice?: any;
  }) {
    // 1. 转换消息格式
    const history = messages.map((msg) => this.openAIMessageToGemini(msg));
    const lastMessage = history.pop();
    if (!lastMessage) {
      throw new Error('No message to send.');
    }

    // 2. 创建一个一次性的 GeminiChat 实例
    const oneShotChat = new GeminiChat(
      this.config,
      this.contentGenerator,
      {}, // generationConfig
      history, // 传入历史记录
    );

    // 3. 构造请求，包含工具定义
    const geminiStream = await oneShotChat.sendMessageStream({
      message: lastMessage.parts || [],
      config: {
        tools: tools,
        toolConfig: tool_choice
          ? { functionCallingConfig: { mode: tool_choice } }
          : undefined,
      },
    });

    return geminiStream;
  }
}
