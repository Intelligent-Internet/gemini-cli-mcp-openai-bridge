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

// OpenAI 请求体中的消息对象
export interface OpenAIMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | MessageContentPart[];
  tool_calls?: any; // 根据需要定义更精确的类型
  tool_call_id?: string;
}

// OpenAI Chat Completion 请求体
export interface OpenAIChatCompletionRequest {
  model: string;
  messages: OpenAIMessage[];
  stream?: boolean;
  tools?: any[]; // 对应 Gemini 的 Tool[]
  tool_choice?: any; // 对应 Gemini 的 ToolConfig
}

export interface ReasoningData {
  reasoning: string;
}

export type StreamChunk =
  | { type: 'text'; data: string }
  | { type: 'reasoning'; data: ReasoningData }
  | { type: 'tool_code'; data: { name: string; args: Record<string, unknown> } };
