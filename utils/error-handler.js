/**
 * Centralized error handling utilities
 */

/**
 * Format error for MCP response
 */
function formatError(error, context = '') {
  const prefix = context ? `[${context}] ` : '';

  if (error.message?.startsWith('ICLOUD_TOOLS_NOT_INSTALLED')) {
    return {
      content: [{
        type: 'text',
        text: `${prefix}${error.message.replace('ICLOUD_TOOLS_NOT_INSTALLED: ', '')}`
      }]
    };
  }

  if (error.message === 'UNAUTHORIZED' || error.message?.includes('authentication')) {
    return {
      content: [{
        type: 'text',
        text: `${prefix}Authentication failed. Please verify your iCloud credentials in .env file.\n\nTo set up:\n1. Go to https://appleid.apple.com\n2. Security → App-Specific Passwords → Generate\n3. Copy the password to ICLOUD_APP_PASSWORD in .env`
      }]
    };
  }

  return {
    content: [{
      type: 'text',
      text: `${prefix}Error: ${error.message || 'Unknown error occurred'}`
    }]
  };
}

/**
 * Create success response
 */
function formatSuccess(text) {
  return {
    content: [{
      type: 'text',
      text: text
    }]
  };
}

/**
 * Wrap handler with error catching
 */
function withErrorHandler(handler, context) {
  return async (args) => {
    try {
      return await handler(args);
    } catch (error) {
      console.error(`[${context}] Error:`, error.message);
      return formatError(error, context);
    }
  };
}

/**
 * Backward-compatible alias used by tool modules.
 */
function handleError(error, context) {
  return formatError(error, context);
}

module.exports = {
  handleError,
  formatError,
  formatSuccess,
  withErrorHandler
};
