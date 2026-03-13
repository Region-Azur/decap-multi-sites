/**
 * Centralized logging utility for both API and Portal services.
 * 
 * Environment variables:
 *  - DEV: Set to 'true' to enable verbose/debug logging
 *  - NODE_ENV: 'production' or 'development' (affects default log level)
 */

const isDev = process.env.DEV === 'true';
const isProduction = process.env.NODE_ENV === 'production';

// ANSI color codes for console output
const colors = {
  reset: '\x1b[0m',
  bright: '\x1b[1m',
  dim: '\x1b[2m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  magenta: '\x1b[35m',
  cyan: '\x1b[36m',
};

/**
 * Format timestamp for logs
 */
function formatTimestamp() {
  return new Date().toISOString();
}

/**
 * Format log message with metadata
 */
function formatMessage(level, message, meta = {}) {
  const timestamp = formatTimestamp();
  const metaStr = Object.keys(meta).length > 0 
    ? ` ${JSON.stringify(meta)}` 
    : '';
  return `[${timestamp}] [${level}]${metaStr} ${message}`;
}

/**
 * Logger object with different log levels
 */
const logger = {
  /**
   * INFO level - always logged in all environments
   * Use for important application events
   */
  info: (message, meta = {}) => {
    const formatted = formatMessage('INFO', message, meta);
    console.log(`${colors.blue}${formatted}${colors.reset}`);
  },

  /**
   * WARN level - always logged, but can be suppressed with filtering
   * Use for warnings and non-critical issues
   */
  warn: (message, meta = {}) => {
    const formatted = formatMessage('WARN', message, meta);
    console.warn(`${colors.yellow}${formatted}${colors.reset}`);
  },

  /**
   * ERROR level - always logged
   * Use for errors and failures
   */
  error: (message, meta = {}) => {
    const formatted = formatMessage('ERROR', message, meta);
    console.error(`${colors.red}${formatted}${colors.reset}`);
  },

  /**
   * DEBUG level - only logged when DEV=true
   * Use for detailed debugging information
   */
  debug: (message, meta = {}) => {
    if (isDev) {
      const formatted = formatMessage('DEBUG', message, meta);
      console.log(`${colors.cyan}${formatted}${colors.reset}`);
    }
  },

  /**
   * TRACE level - only logged when DEV=true
   * Use for very detailed tracing (function entry/exit, variable values)
   */
  trace: (message, meta = {}) => {
    if (isDev) {
      const formatted = formatMessage('TRACE', message, meta);
      console.log(`${colors.dim}${formatted}${colors.reset}`);
    }
  },

  /**
   * SUCCESS level - only logged in development or when explicitly enabled
   * Use for successful operations
   */
  success: (message, meta = {}) => {
    const formatted = formatMessage('SUCCESS', message, meta);
    console.log(`${colors.green}${formatted}${colors.reset}`);
  },

  /**
   * Log HTTP requests (middleware helper)
   */
  request: (method, path, statusCode, responseTime = null, meta = {}) => {
    const timeStr = responseTime ? ` (${responseTime}ms)` : '';
    const status = statusCode >= 400 ? colors.red : colors.green;
    const log = `${method} ${path} ${statusCode}${timeStr}`;
    console.log(`${status}${formatMessage('HTTP', log, meta)}${colors.reset}`);
  },

  /**
   * Log authentication events
   */
  auth: (action, email, result = 'success', meta = {}) => {
    if (isDev) {
      const formatted = formatMessage('AUTH', `${action} for ${email}: ${result}`, meta);
      console.log(`${colors.magenta}${formatted}${colors.reset}`);
    }
  },

  /**
   * Check if debug/verbose logging is enabled
   */
  isDebug: () => isDev,

  /**
   * Check if production environment
   */
  isProduction: () => isProduction,

  /**
   * Check if development environment
   */
  isDev: () => isDev,
};

module.exports = logger;

