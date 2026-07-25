#!/usr/bin/env node

const config = require('./config');
const { createMcpCore } = require('./mcp-core');
const { createHttpServer } = require('./transport/http-streamable');

const core = createMcpCore();
const app = createHttpServer(core, { path: config.MCP_HTTP_PATH });

const host = config.MCP_HTTP_HOST;
const port = config.MCP_HTTP_PORT;

const server = app.listen(port, host, () => {
  console.error('[icloud-mcp] Starting HTTP MCP server...');
  console.error(`[icloud-mcp] Mode: ${core.mode}`);
  console.error(`[icloud-mcp] Tools available: ${core.tools.length}`);
  console.error(`[icloud-mcp] Endpoint: http://${host}:${port}${config.MCP_HTTP_PATH}`);
  console.error('[icloud-mcp] Supports JSON-RPC over HTTP and SSE streaming responses');
});

function shutdown(signal) {
  console.error(`[icloud-mcp] Received ${signal}, shutting down HTTP server`);
  server.close(() => process.exit(0));
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
