/**
 * HTTP logging middleware for Express applications.
 * Logs all HTTP requests with timing information.
 */

const logger = require('../shared/logger');

/**
 * HTTP request/response logging middleware
 * Logs:
 *  - Request: method, path, query params
 *  - Response: status code, response time
 *  - Errors: with status and error details
 */
function httpLogger(req, res, next) {
  const startTime = Date.now();
  const originalSend = res.send;

  // Override res.send to capture response status and timing
  res.send = function(data) {
    const responseTime = Date.now() - startTime;
    const statusCode = res.statusCode;

    // Build metadata
    const meta = {
      method: req.method,
      path: req.path,
      ip: req.ip || req.connection.remoteAddress,
      responseTime,
    };

    // Add query params if present (only in dev)
    if (Object.keys(req.query).length > 0 && logger.isDebug()) {
      meta.query = req.query;
    }

    // Add request body size if present (only in dev)
    if (req.body && logger.isDebug()) {
      meta.bodySize = JSON.stringify(req.body).length;
    }

    // Log based on status code
    if (statusCode >= 500) {
      logger.error(`${req.method} ${req.path}`, {
        ...meta,
        statusCode,
      });
    } else if (statusCode >= 400) {
      logger.warn(`${req.method} ${req.path}`, {
        ...meta,
        statusCode,
      });
    } else {
      logger.request(req.method, req.path, statusCode, responseTime, meta);
    }

    // Call original send
    return originalSend.call(this, data);
  };

  next();
}

module.exports = httpLogger;

