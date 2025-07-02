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
  type StreamChunk,
  type ReasoningData,
} from './types.js';

/**
 * Recursively removes fields from a JSON schema that are not supported by the
 * Gemini API.
 * @param schema The JSON schema to sanitize.
 * @returns A new schema object without the unsupported fields.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function sanitizeGeminiSchema(schema: any): any {
  if (typeof schema !== 'object' || schema === null) {
    return schema;
  }

  // Create a new object, filtering out unsupported keys at the current level.
  const newSchema: { [key: string]: any } = {};
  for (const key in schema) {
    if (key !== '$schema' && key !== 'additionalProperties') {
      newSchema[key] = schema[key];
    }
  }

  // Recurse into nested 'properties' and 'items'.
  if (newSchema.properties) {
    const newProperties: { [key: string]: any } = {};
    for (const key in newSchema.properties) {
      newProperties[key] = sanitizeGeminiSchema(newSchema.properties[key]);
    }
    newSchema.properties = newProperties;
  }

  if (newSchema.items) {
    newSchema.items = sanitizeGeminiSchema(newSchema.items);
  }

  return newSchema;
}

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
      .map(tool => {
        const sanitizedParameters = sanitizeGeminiSchema(
          tool.function.parameters,
        );
        return {
          name: tool.function.name,
          description: tool.function.description,
          parameters: sanitizedParameters,
        };
      });

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
    // Handle assistant messages, which can contain both text and tool calls
    if (msg.role === 'assistant') {
      const parts: Part[] = [];

      // Handle text content. It can be null when tool_calls are present.
      if (msg.content && typeof msg.content === 'string') {
        parts.push({ text: msg.content });
      }

      // Handle tool calls
      if (msg.tool_calls && Array.isArray(msg.tool_calls)) {
        for (const toolCall of msg.tool_calls) {
          if (toolCall.type === 'function' && toolCall.function) {
            try {
              // Gemini API's functionCall.args expects an object, not a string.
              // OpenAI's arguments is a JSON string, so it needs to be parsed.
              const argsObject = JSON.parse(toolCall.function.arguments);
              parts.push({
                functionCall: {
                  name: toolCall.function.name,
                  args: argsObject,
                },
              });
            } catch (e) {
              console.error(
                '[GeminiApiClient] Error parsing tool call arguments:',
                e,
              );
            }
          }
        }
      }
      return { role: 'model', parts };
    }

    // Handle tool responses
    if (msg.role === 'tool') {
      const functionName = this.parseFunctionNameFromId(msg.tool_call_id || '');
      let responsePayload: Record<string, unknown>;

      try {
        const parsed = JSON.parse(msg.content as string);

        // The Gemini API expects an object for the response.
        // If the parsed content is a non-null, non-array object, use it directly.
        // Otherwise, wrap primitives, arrays, or null in an object.
        if (
          typeof parsed === 'object' &&
          parsed !== null &&
          !Array.isArray(parsed)
        ) {
          responsePayload = parsed as Record<string, unknown>;
        } else {
          responsePayload = { output: parsed };
        }
      } catch (e) {
        // If parsing fails, it's a plain string. Wrap it.
        responsePayload = { output: msg.content };
      }

      return {
        role: 'user', // Gemini uses 'user' role to hold a functionResponse
        parts: [
          {
            functionResponse: {
              id: msg.tool_call_id,
              name: functionName,
              // Pass the parsed or wrapped object as the response value.
              response: responsePayload,
            },
          },
        ],
      };
    }

    // Handle user and system messages
    const role = 'user'; // system and user roles are mapped to 'user'

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
  }): Promise<AsyncGenerator<StreamChunk>> {
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
    // Transform the event stream to a simpler StreamChunk stream
    return (async function* (): AsyncGenerator<StreamChunk> {
      for await (const response of geminiStream) {
        const parts = response.candidates?.[0]?.content?.parts || [];
        for (const part of parts) {
          if (part.text) {
            yield { type: 'text', data: part.text };
          }
          if (part.functionCall && part.functionCall.name) {
            yield {
              type: 'tool_code',
              data: {
                name: part.functionCall.name,
                args:
                  (part.functionCall.args as Record<string, unknown>) ?? {},
              },
            };
          }
        }
      }
    })();
  }
}
