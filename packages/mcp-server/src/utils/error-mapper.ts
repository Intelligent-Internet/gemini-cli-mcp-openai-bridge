import { type OpenAIError, type OpenAIErrorResponse } from '../types.js';

/**
 * 将从 Gemini API 或身份验证流程中捕获的错误映射为标准的 OpenAI 错误对象和对应的 HTTP 状态码。
 * @param error 捕获到的未知错误。
 * @returns 一个包含标准 OpenAI 错误对象和建议的 HTTP 状态码的对象。
 */
export function mapErrorToOpenAIError(error: unknown): {
  openAIError: OpenAIErrorResponse;
  statusCode: number;
} {
  let message = 'An unknown error occurred.';
  let type: OpenAIError['type'] = 'server_error';
  let code: string | null = 'internal_error';
  let statusCode = 500;

  if (error instanceof Error) {
    message = error.message;

    // 检查特定的错误类型或消息内容来确定更精确的错误码
    if (message.includes('Authentication failed')) {
      statusCode = 401;
      type = 'authentication_error';
      code = 'invalid_api_key';
      message =
        'Invalid authentication credentials. Please check your GCP_SERVICE_ACCOUNT.';
    } else if (
      message.includes('429') ||
      message.toLowerCase().includes('quota')
    ) {
      statusCode = 429;
      type = 'server_error';
      code = 'rate_limit_exceeded';
      message =
        'You exceeded your current quota, please check your plan and billing details.';
    } else if (
      message.includes('400') ||
      message.toLowerCase().includes('invalid')
    ) {
      statusCode = 400;
      type = 'invalid_request_error';
      code = 'invalid_request';
    } else if (message.includes('500')) {
      statusCode = 500;
      type = 'server_error';
      code = 'server_error';
    }
    // 可以根据需要添加更多针对 Gemini 特定错误的映射
  }

  const openAIError: OpenAIErrorResponse = {
    error: {
      message,
      type,
      param: null, // 在这个场景下，我们通常不知道是哪个具体参数出错，所以设为 null
      code,
    },
  };

  return { openAIError, statusCode };
}
