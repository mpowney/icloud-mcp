#!/usr/bin/env node

/**
 * iCloud MCP Server
 *
 * Provides Claude with access to Apple services:
 * - Email (via IMAP/SMTP or Mail.app)
 * - Calendar (via CalDAV or Calendar.app)
 * - Contacts (via CardDAV or Contacts.app)
 * - Reminders (via Reminders.app - local only)
 * - Notes (via Notes.app - local only)
 * - Messages (via Messages.app - local only)
 * - Safari (via Safari.app - local only)
 * - Music (via Music.app - local only)
 * - iCloud Drive files (local sync folder - local only)
 *
 * Modes:
 * - LOCAL (default): Uses AppleScript to access native macOS apps (fast, requires Mac)
 * - CLOUD: Uses iCloud protocols (IMAP, CalDAV, CardDAV) - works from anywhere
 */

const readline = require('readline');
const config = require('./config');
const { createMcpCore } = require('./mcp-core');

const core = createMcpCore();
const TOOLS = core.tools;
const MODE = core.mode;
const handleRequest = core.handleRequest;

/**
 * Start the MCP server
 */
function startServer() {
  console.error('[icloud-mcp] Starting iCloud MCP server...');
  console.error(`[icloud-mcp] Mode: ${MODE}`);
  console.error(`[icloud-mcp] Tools available: ${TOOLS.length}`);

  if (MODE === 'local') {
    console.error('[icloud-mcp] Services: Email, Calendar, Contacts, Reminders, Notes, Messages, Safari, Music, iCloud Drive');
  } else {
    console.error('[icloud-mcp] Services: Email, Calendar, Contacts');
    console.error(`[icloud-mcp] Credentials configured: ${!!(config.ICLOUD_EMAIL && config.ICLOUD_APP_PASSWORD)}`);
  }

  if (config.USE_TEST_MODE) {
    console.error('[icloud-mcp] TEST MODE ENABLED');
  }

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: false
  });

  let buffer = '';

  rl.on('line', async (line) => {
    buffer += line;

    try {
      const request = JSON.parse(buffer);
      buffer = '';

      const response = await handleRequest(request);

      if (response) {
        const responseStr = JSON.stringify(response);
        process.stdout.write(responseStr + '\n');
      }
    } catch (e) {
      // Not a complete JSON yet, continue buffering
      if (!(e instanceof SyntaxError)) {
        console.error('[icloud-mcp] Parse error:', e.message);
        buffer = '';
      }
    }
  });

  rl.on('close', () => {
    console.error('[icloud-mcp] Server shutting down');
    process.exit(0);
  });

  process.on('SIGINT', () => {
    console.error('[icloud-mcp] Received SIGINT, shutting down');
    process.exit(0);
  });

  process.on('SIGTERM', () => {
    console.error('[icloud-mcp] Received SIGTERM, shutting down');
    process.exit(0);
  });
}

// Start the server
startServer();
