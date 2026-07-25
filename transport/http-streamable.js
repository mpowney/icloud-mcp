const express = require('express');

function isSseRequest(req) {
  const accept = (req.get('accept') || '').toLowerCase();
  const queryMode = String(req.query?.transport || '').toLowerCase();
  const queryStream = String(req.query?.stream || '').toLowerCase();

  return accept.includes('text/event-stream') || queryMode === 'sse' || queryStream === 'true';
}

function writeSseEvent(res, event, data) {
  res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

function createParseError() {
  return {
    jsonrpc: '2.0',
    id: null,
    error: {
      code: -32700,
      message: 'Parse error'
    }
  };
}

function createInvalidRequestError(id = null, message = 'Invalid Request') {
  return {
    jsonrpc: '2.0',
    id,
    error: {
      code: -32600,
      message
    }
  };
}

function createHttpServer(core, options = {}) {
  const app = express();
  const path = options.path || '/mcp';

  app.disable('x-powered-by');
  app.use(express.json({ limit: '1mb' }));

  app.get(path, (req, res) => {
    // SSE handshake endpoint for clients that expect long-lived connection setup.
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders?.();

    writeSseEvent(res, 'ready', {
      server: core.serverInfo.name,
      mode: core.mode,
      path
    });

    const keepAlive = setInterval(() => {
      res.write(': keep-alive\n\n');
    }, 15000);

    req.on('close', () => {
      clearInterval(keepAlive);
    });
  });

  app.post(path, async (req, res) => {
    const useSse = isSseRequest(req);
    const payload = req.body;

    if (!payload || typeof payload !== 'object') {
      const errorResponse = createInvalidRequestError(null, 'Expected JSON object request body');
      if (useSse) {
        res.setHeader('Content-Type', 'text/event-stream');
        res.setHeader('Cache-Control', 'no-cache, no-transform');
        res.setHeader('Connection', 'keep-alive');
        res.flushHeaders?.();
        writeSseEvent(res, 'message', errorResponse);
        writeSseEvent(res, 'done', { ok: false });
        res.end();
      } else {
        res.status(400).json(errorResponse);
      }
      return;
    }

    if (useSse) {
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache, no-transform');
      res.setHeader('Connection', 'keep-alive');
      res.setHeader('X-Accel-Buffering', 'no');
      res.flushHeaders?.();
    }

    try {
      const requests = Array.isArray(payload) ? payload : [payload];
      const responses = [];

      for (const request of requests) {
        if (!request || typeof request !== 'object' || request.jsonrpc !== '2.0' || typeof request.method !== 'string') {
          const invalid = createInvalidRequestError(request?.id ?? null);
          responses.push(invalid);
          if (useSse) {
            writeSseEvent(res, 'message', invalid);
          }
          continue;
        }

        const response = await core.handleRequest(request);
        if (response) {
          responses.push(response);
          if (useSse) {
            writeSseEvent(res, 'message', response);
          }
        }
      }

      if (useSse) {
        writeSseEvent(res, 'done', { count: responses.length });
        res.end();
        return;
      }

      if (Array.isArray(payload)) {
        res.json(responses);
      } else if (responses.length > 0) {
        res.json(responses[0]);
      } else {
        res.status(204).end();
      }
    } catch (error) {
      const errorResponse = createInvalidRequestError(null, error.message || 'Request handling failed');
      if (useSse) {
        writeSseEvent(res, 'message', errorResponse);
        writeSseEvent(res, 'done', { ok: false });
        res.end();
      } else {
        res.status(500).json(errorResponse);
      }
    }
  });

  app.use((err, req, res, next) => {
    // Express emits SyntaxError for invalid JSON payloads.
    if (err instanceof SyntaxError) {
      res.status(400).json(createParseError());
      return;
    }
    next(err);
  });

  return app;
}

module.exports = {
  createHttpServer
};
