/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

// OpenAI 请求体中的消息内容部分
export interface MessageContentPart {
  type: 'text' | 'image_url';
  text?: string;
  image_url?: {
    url: string;
    detail?: 'low' | 'high' | 'auto';
  };
}

// OpenAI 工具调用对象
export interface OpenAIToolCall {
  id: string;
  type: 'function';
  function: {
    name: string;
    arguments: string; // 这是一个 JSON 字符串
  };
}

// OpenAI 请求体中的消息对象
export interface OpenAIMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null | MessageContentPart[]; // 当 tool_calls 存在时，content 可能为 null
  tool_calls?: OpenAIToolCall[];
  tool_call_id?: string;
}

// OpenAI 工具定义
export interface OpenAIFunction {
  name: string;
  description?: string;
  parameters: Record<string, unknown>; // JSON Schema object
}

export interface OpenAITool {
  type: 'function';
  function: OpenAIFunction;
}

// OpenAI Chat Completion 请求体
export interface OpenAIChatCompletionRequest {
  model: string;
  messages: OpenAIMessage[];
  stream?: boolean;
  tools?: OpenAITool[]; // 对应 Gemini 的 Tool[]
  tool_choice?: any; // 对应 Gemini 的 ToolConfig
}

export interface ReasoningData {
  reasoning: string;
}

export type StreamChunk =
  | { type: 'text'; data: string }
  | { type: 'reasoning'; data: ReasoningData }
  | { type: 'tool_code'; data: { name: string; args: Record<string, unknown> } };
