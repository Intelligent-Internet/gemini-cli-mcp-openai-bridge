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
      .filter(tool => tool.type === 'function' && tool.function)
      .map(tool => ({
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
   * 从 tool_call_id 中解析出原始的函数名。
   * ID 格式为 "call_{functionName}_{uuid}"
   */
  private parseFunctionNameFromId(toolCallId: string): string {
    const parts = toolCallId.split('_');
    if (parts.length > 2 && parts[0] === 'call') {
      // 重新组合可能包含下划线的函数名
      return parts.slice(1, parts.length - 1).join('_');
    }
    // 回退机制，虽然不理想，但比发送错误名称要好
    return 'unknown_tool_from_id';
  }

  /**
   * 将 OpenAI 格式的消息转换为 Gemini 格式的 Content 对象。
   */
  private openAIMessageToGemini(msg: OpenAIMessage): Content {
    const role = msg.role === 'assistant' ? 'model' : 'user';

    if (msg.role === 'tool') {
      const functionName = this.parseFunctionNameFromId(msg.tool_call_id || '');
      return {
        role: 'user', // Gemini 使用 'user' role 来承载 functionResponse
        parts: [
          {
            functionResponse: {
              name: functionName,
              response: {
                // Gemini 期望 response 是一个对象，我们把工具的输出放在这里
                // 假设工具输出是一个 JSON 字符串，我们解析它
                // 如果不是，就直接作为字符串
                output: msg.content,
              },
            },
          },
        ],
      };
    }

    if (typeof msg.content === 'string') {
      return { role, parts: [{ text: msg.content }] };
    }

    if (Array.isArray(msg.content)) {
      const parts = msg.content.reduce<Part[]>((acc, part: MessageContentPart) => {
        if (part.type === 'text') {
          acc.push({ text: part.text || '' });
        } else if (part.type === 'image_url' && part.image_url) {
          const imageUrl = part.image_url.url;
          if (imageUrl.startsWith('data:')) {
            const [mimePart, dataPart] = imageUrl.split(',');
            const mimeType = mimePart.split(':')[1].split(';')[0];
            acc.push({ inlineData: { mimeType, data: dataPart } });
          } else {
            // Gemini API 更喜欢 inlineData，但 fileData 也可以作为备选
            acc.push({ fileData: { mimeType: 'image/jpeg', fileUri: imageUrl } });
          }
        }
        return acc;
      }, []);

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
    const history = messages.map(msg => this.openAIMessageToGemini(msg));
    const lastMessage = history.pop();
    console.log(
      '[GeminiApiClient] Sending to Gemini. History:',
      JSON.stringify(history, null, 2),
    );
    console.log(
      '[GeminiApiClient] Last Message:',
      JSON.stringify(lastMessage, null, 2),
    );
    if (!lastMessage) {
      throw new Error('No message to send.');
    }

    // 为每个请求创建一个新的、独立的聊天会话
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

    console.log('[GeminiApiClient] Got stream from Gemini.');
    return geminiStream;
  }
}
