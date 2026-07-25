/**
 * Shared MCP server core.
 * Keeps tool registry and JSON-RPC handlers transport-agnostic.
 */

const config = require('./config');
const { authTools } = require('./auth');

function loadToolsAndMode() {
  let tools = [...authTools];
  let mode = 'cloud';

  if (config.USE_LOCAL_MODE && config.IS_MACOS) {
    mode = 'local';

    const { remindersTools } = require('./reminders');
    const { notesTools } = require('./notes');
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

  return { tools, mode };
}

function createServerInfo(mode) {
  return {
    name: 'icloud-mcp',
    version: '2.0.0',
    description: `MCP server for Apple services (Mode: ${mode})`
  };
}

function createMcpCore() {
  const { tools, mode } = loadToolsAndMode();
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
                tools: {}
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
    serverInfo,
    handleRequest
  };
}

module.exports = {
  createMcpCore
};
