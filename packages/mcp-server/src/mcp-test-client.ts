import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import {
  ListToolsResultSchema,
  type Notification,
} from '@modelcontextprotocol/sdk/types.js';
import { URL } from 'url';
import { z } from 'zod';
import OpenAI from 'openai';

// Define the schema for a text content block, as it's not exported by the SDK.
const TextContentBlockSchema = z.object({
  type: z.literal('text'),
  text: z.string(),
});

// --- CONFIG ---
const SERVER_URL = 'http://localhost:8765/mcp';
const LOG_PREFIX = '[TEST CLIENT]';

function logWithPrefix(...args: unknown[]) {
  console.log(LOG_PREFIX, ...args);
}

// --- Monkey-patch fetch for logging ---
const originalFetch = global.fetch;
global.fetch = async (url, options) => {
  logWithPrefix('➡️  FETCHING:', options?.method || 'GET', url.toString());
  if (options?.headers) {
    logWithPrefix(
      '   Headers:',
      JSON.stringify(
        Object.fromEntries((options.headers as Headers).entries()),
        null,
        2,
      ),
    );
  }
  if (options?.body) {
    const bodyStr = options.body.toString();
    logWithPrefix(
      '   Body:',
      bodyStr.length > 300 ? bodyStr.substring(0, 300) + '...' : bodyStr,
    );
  }

  const response = await originalFetch(url, options);

  logWithPrefix(
    '⬅️  RESPONSE:',
    response.status,
    response.statusText,
    'from',
    options?.method || 'GET',
    url.toString(),
  );
  logWithPrefix(
    '   Response Headers:',
    JSON.stringify(Object.fromEntries(response.headers.entries()), null, 2),
  );

  const clonedResponse = response.clone();
  clonedResponse
    .text()
    .then(text => {
      if (text) {
        logWithPrefix(
          '   Response Body:',
          text.length > 300 ? text.substring(0, 300) + '...' : text,
        );
      }
    })
    .catch(() => {});

  return response;
};
// ------------------------------------

async function runTestClient() {
  logWithPrefix('🚀 Starting MCP Test Client...');
  logWithPrefix(`🎯 Target Server URL: ${SERVER_URL}`);

  const client = new Client({
    name: 'mcp-debug-client',
    version: '1.0.0',
  });

  client.onerror = (error: Error) => {
    console.error(`${LOG_PREFIX} 💥 Client-level Error:`, error);
  };

  client.fallbackNotificationHandler = async (notification: Notification) => {
    logWithPrefix(
      `📡 Received Unhandled Notification:`,
      JSON.stringify(notification, null, 2),
    );
  };

  logWithPrefix('🚌 Creating StreamableHTTPClientTransport...');
  const transport = new StreamableHTTPClientTransport(new URL(SERVER_URL));

  transport.onmessage = message => {
    logWithPrefix('📥 Received Message:', JSON.stringify(message, null, 2));
  };

  try {
    logWithPrefix('🔌 Attempting to connect to server...');
    await client.connect(transport);
    logWithPrefix('✅ Connection successful! Initialization complete.');
    logWithPrefix('🔎 Server Info:', client.getServerVersion());
    logWithPrefix('🛠️ Server Capabilities:', client.getServerCapabilities());
  } catch (error) {
    console.error(`${LOG_PREFIX} ❌ Failed to connect or initialize:`, error);
    process.exit(1);
  }

  try {
    logWithPrefix('📋 Requesting tool list...');
    const result = await client.request(
      { method: 'tools/list' },
      ListToolsResultSchema,
    );

    logWithPrefix('✅ Successfully received tool list response!');

    if (result.tools && result.tools.length > 0) {
      logWithPrefix(`🛠️ Discovered ${result.tools.length} tools:`);
      result.tools.forEach((tool, index) => {
        logWithPrefix(`  ${index + 1}. Name: ${tool.name}`);
        logWithPrefix(`     Title: ${tool.title || 'N/A'}`);
        logWithPrefix(`     Description: ${tool.description || 'N/A'}`);
        logWithPrefix(
          `     Input Schema:`,
          JSON.stringify(tool.inputSchema, null, 2),
        );
      });
    } else {
      logWithPrefix('⚠️ Server returned an empty list of tools.');
    }
  } catch (error) {
    console.error(`${LOG_PREFIX} ❌ Failed to list tools:`, error);
  } finally {
    logWithPrefix('👋 Closing MCP connection...');
    await client.close();
    logWithPrefix('🚪 MCP Connection closed.');
  }

  // Now, test the OpenAI endpoint
  await testOpenAIEndpoint();

  logWithPrefix('✅ Test finished.');
}

async function testOpenAIEndpoint() {
  logWithPrefix('-----------------------------------');
  logWithPrefix('🚀 Testing OpenAI compatible endpoint...');

  const openai = new OpenAI({
    baseURL: 'http://localhost:8765/v1',
    apiKey: 'not-needed', // The API key is not used by our local server
  });

  try {
    const stream = await openai.chat.completions.create({
      model: 'gemini-pro', // This can be any string, it's passed to the transformer
      messages: [{ role: 'user', content: 'Why is the sky blue?' }],
      stream: true,
    });

    let fullResponse = '';
    logWithPrefix('✅ Stream opened. Receiving response...');
    for await (const chunk of stream) {
      const content = chunk.choices[0]?.delta?.content || '';
      fullResponse += content;
      process.stdout.write(content);
    }
    console.log(''); // Newline after stream

    if (fullResponse.toLowerCase().includes('scattering')) {
      logWithPrefix('✅ Validation successful: Response contains "scattering".');
    } else {
      console.error(
        `${LOG_PREFIX} ❌ Validation failed: Response did not contain "scattering".`,
      );
    }
  } catch (error) {
    console.error(
      `${LOG_PREFIX} ❌ Failed to call OpenAI endpoint:`,
      error,
    );
  }
  logWithPrefix('-----------------------------------');
}

runTestClient().catch(error => {
  console.error(`${LOG_PREFIX} 🚨 Unhandled top-level error:`, error);
  process.exit(1);
});
