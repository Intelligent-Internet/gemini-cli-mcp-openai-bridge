import { type OpenAIError, type OpenAIErrorResponse } from '../types.js';

/**
 * Maps a caught error from the Gemini API or auth flow to a standard
 * OpenAI error object and a corresponding HTTP status code.
 * @param error The caught unknown error.
 * @returns An object containing the standard OpenAI error and a suggested status code.
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

    // Check for specific error messages to determine a more accurate error code.
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
    // More Gemini-specific error mappings can be added here if needed.
  }

  const openAIError: OpenAIErrorResponse = {
    error: {
      message,
      type,
      // We generally don't know the specific parameter that caused the error in this context.
      param: null,
      code,
    },
  };

  return { openAIError, statusCode };
}
