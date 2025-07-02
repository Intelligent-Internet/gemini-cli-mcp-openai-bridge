/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { type Config, GeminiChat } from '@google/gemini-cli-core';
import {
  type Content,
  type Part,
  type Tool,
  type FunctionDeclaration,
  type GenerateContentConfig,
  FunctionCallingConfigMode,
} from '@google/genai';
import {
  type OpenAIMessage,
  type MessageContentPart,
  type OpenAIChatCompletionRequest,
} from './types.js';

export class GeminiApiClient {
  private readonly config: Config;
  private readonly contentGenerator;

  constructor(config: Config) {
    this.config = config;
    this.contentGenerator = this.config.getGeminiClient().getContentGenerator();
  }

  /**
   * 将 OpenAI 的工具定义转换为 Gemini 的工具定义。
   */
  private convertOpenAIToolsToGemini(
    openAITools?: OpenAIChatCompletionRequest['tools'],
  ): Tool[] | undefined {
    if (!openAITools || openAITools.length === 0) {
      return undefined;
    }

    const functionDeclarations: FunctionDeclaration[] = openAITools
      .filter((tool) => tool.type === 'function' && tool.function)
      .map((tool) => ({
        name: tool.function.name,
        description: tool.function.description,
        parameters: tool.function.parameters,
      }));

    if (functionDeclarations.length === 0) {
      return undefined;
    }

    return [{ functionDeclarations }];
  }

  /**
   * 将 OpenAI 格式的消息转换为 Gemini 格式的 Content 对象。
   */
  private openAIMessageToGemini(msg: OpenAIMessage): Content {
    const role = msg.role === 'assistant' ? 'model' : 'user';

    if (msg.role === 'tool') {
      return {
        role: 'user', // Gemini 使用 'user' role 来承载 functionResponse
        parts: [
          {
            functionResponse: {
              name: msg.tool_call_id || 'unknown_tool', // 需要一个工具名
              response: { content: msg.content },
            },
          },
        ],
      };
    }

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
            return { fileData: { mimeType: 'image/jpeg', fileUri: imageUrl } };
          }
          return { text: '' };
        })
        .filter((p) => p.text !== '' || p.inlineData || p.fileData);

      return { role, parts };
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
    tools?: OpenAIChatCompletionRequest['tools'];
    tool_choice?: any;
  }) {
    const history = messages.map(this.openAIMessageToGemini);
    const lastMessage = history.pop();
    if (!lastMessage) {
      throw new Error('No message to send.');
    }

    const oneShotChat = new GeminiChat(
      this.config,
      this.contentGenerator,
      {},
      history,
    );

    const geminiTools = this.convertOpenAIToolsToGemini(tools);

    const generationConfig: GenerateContentConfig = {};
    if (tool_choice && tool_choice !== 'auto') {
      generationConfig.toolConfig = {
        functionCallingConfig: {
          mode:
            tool_choice.type === 'function'
              ? FunctionCallingConfigMode.ANY
              : FunctionCallingConfigMode.AUTO,
          allowedFunctionNames: tool_choice.function
            ? [tool_choice.function.name]
            : undefined,
        },
      };
    }

    const geminiStream = await oneShotChat.sendMessageStream({
      message: lastMessage.parts || [],
      config: {
        tools: geminiTools,
        ...generationConfig,
      },
    });

    return geminiStream;
  }
}
