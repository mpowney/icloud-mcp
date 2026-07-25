/**
 * Shared MCP server core.
 * Keeps tool registry and JSON-RPC handlers transport-agnostic.
 */

const config = require('./config');
const { authTools } = require('./auth');

function loadToolsAndMode() {
  let tools = [...authTools];
  let mode = 'cloud';
  let resourceProviders = [];

  if (config.USE_LOCAL_MODE && config.IS_MACOS) {
    mode = 'local';

    const { remindersTools } = require('./reminders');
    const { notesTools, notesResources } = require('./notes');
    const { messagesTools } = require('./messages');
    const { safariTools } = require('./safari');
    const { musicTools } = require('./music');
    const { filesTools } = require('./files');
    const { emailTools } = require('./email');
    const { calendarTools } = require('./calendar');
    const { contactsTools } = require('./contacts');

    tools = [
      ...authTools,
      ...emailTools,
      ...calendarTools,
      ...contactsTools,
      ...remindersTools,
      ...notesTools,
      ...messagesTools,
      ...safariTools,
      ...musicTools,
      ...filesTools
    ];

    resourceProviders = [notesResources].filter(Boolean);
  } else {
    const { emailTools } = require('./email');
    const { calendarTools } = require('./calendar');
    const { contactsTools } = require('./contacts');

    if (config.USE_LOCAL_MODE && !config.IS_MACOS) {
      mode = 'cloud (fallback - not macOS)';
    }

    tools = [
      ...authTools,
      ...emailTools,
      ...calendarTools,
      ...contactsTools
    ];
  }

  return { tools, mode, resourceProviders };
}

function createServerInfo(mode) {
  return {
    name: 'icloud-mcp',
    version: '2.0.0',
    description: `MCP server for Apple services (Mode: ${mode})`
  };
}

function createMcpCore() {
  const { tools, mode, resourceProviders } = loadToolsAndMode();
  const serverInfo = createServerInfo(mode);

  async function handleRequest(request) {
    const { method, params, id } = request || {};

    try {
      switch (method) {
        case 'initialize':
          return {
            jsonrpc: '2.0',
            id,
            result: {
              protocolVersion: '2024-11-05',
              serverInfo,
              capabilities: {
                tools: {},
                resources: {}
              }
            }
          };

        case 'notifications/initialized':
          return null;

        case 'tools/list':
          return {
            jsonrpc: '2.0',
            id,
            result: {
              tools: tools.map((tool) => ({
                name: tool.name,
                description: tool.description,
                inputSchema: tool.inputSchema
              }))
            }
          };

        case 'resources/list': {
          const resources = [];

          for (const provider of resourceProviders) {
            if (!provider || typeof provider.list !== 'function') continue;

            const listed = await provider.list();
            if (Array.isArray(listed)) {
              resources.push(...listed);
            }
          }

          return {
            jsonrpc: '2.0',
            id,
            result: {
              resources
            }
          };
        }

        case 'resources/read': {
          const uri = params?.uri;
          if (!uri || typeof uri !== 'string') {
            return {
              jsonrpc: '2.0',
              id,
              error: {
                code: -32602,
                message: 'resources/read requires a string uri'
              }
            };
          }

          for (const provider of resourceProviders) {
            if (!provider || typeof provider.read !== 'function') continue;

            const content = await provider.read(uri);
            if (content) {
              return {
                jsonrpc: '2.0',
                id,
                result: {
                  contents: [content]
                }
              };
            }
          }

          return {
            jsonrpc: '2.0',
            id,
            error: {
              code: -32602,
              message: `Resource not found: ${uri}`
            }
          };
        }

        case 'tools/call': {
          const toolName = params?.name;
          const toolArgs = params?.arguments || {};

          const tool = tools.find((t) => t.name === toolName);
          if (!tool) {
            return {
              jsonrpc: '2.0',
              id,
              error: {
                code: -32601,
                message: `Unknown tool: ${toolName}`
              }
            };
          }

          console.error(`[icloud-mcp] Calling tool: ${toolName}`);

          const result = await tool.handler(toolArgs);

          return {
            jsonrpc: '2.0',
            id,
            result
          };
        }

        default:
          return {
            jsonrpc: '2.0',
            id,
            error: {
              code: -32601,
              message: `Unknown method: ${method}`
            }
          };
      }
    } catch (error) {
      console.error(`[icloud-mcp] Error handling ${method}:`, error.message);
      return {
        jsonrpc: '2.0',
        id,
        error: {
          code: -32603,
          message: error.message
        }
      };
    }
  }

  return {
    tools,
    mode,
    resourceProviders,
    serverInfo,
    handleRequest
  };
}

module.exports = {
  createMcpCore
};
