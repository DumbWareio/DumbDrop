/**
 * Logger utility for consistent logging across the application
 * Provides standardized timestamp and log level formatting
 */

const fs = require('fs');
const path = require('path');
const util = require('util');

// Debug mode can be enabled via environment variable
const DEBUG_MODE = process.env.DEBUG === 'true' || process.env.NODE_ENV === 'development';
const ACCESS_LOG_ENABLED = process.env.ACCESS_LOG_ENABLED !== 'false';
const LOG_TO_FILE = process.env.LOG_TO_FILE !== 'false';
const LOG_DIR = process.env.LOG_DIR || (process.env.NODE_ENV === 'production' ? '/logs' : './logs');
const DAY_MS = 24 * 60 * 60 * 1000;
const LOG_RETENTION_DAYS = getPositiveInteger(process.env.LOG_RETENTION_DAYS, 90);
const LOG_ROTATION_DAYS = getPositiveInteger(process.env.LOG_ROTATION_DAYS, 30);
const LOG_PREFIXES = new Set(['container', 'app', 'error', 'debug', 'access']);

let fileLoggingReady = false;

function getPositiveInteger(rawValue, fallback) {
  const parsed = Number.parseInt(rawValue || '', 10);
  if (Number.isNaN(parsed) || parsed <= 0) {
    return fallback;
  }

  return parsed;
}

function initializeFileLogging() {
  if (!LOG_TO_FILE) {
    return;
  }

  try {
    fs.mkdirSync(LOG_DIR, { recursive: true });
    pruneOldLogs();
    fileLoggingReady = true;
  } catch (err) {
    // Do not crash app startup if file logging cannot be initialized.
    console.error(`[ERROR] ${new Date().toISOString()} - Failed to initialize log directory (${LOG_DIR}): ${err.message}`);
  }
}

function getRotationWindowStart(date = new Date()) {
  const windowSpanMs = LOG_ROTATION_DAYS * DAY_MS;
  const windowStartMs = Math.floor(date.getTime() / windowSpanMs) * windowSpanMs;
  return new Date(windowStartMs);
}

function formatDateStamp(date) {
  const year = date.getUTCFullYear();
  const month = `${date.getUTCMonth() + 1}`.padStart(2, '0');
  const day = `${date.getUTCDate()}`.padStart(2, '0');
  return `${year}${month}${day}`;
}

function parseDateStamp(stamp) {
  if (!/^\d{8}$/.test(stamp)) {
    return null;
  }

  const year = Number.parseInt(stamp.slice(0, 4), 10);
  const month = Number.parseInt(stamp.slice(4, 6), 10) - 1;
  const day = Number.parseInt(stamp.slice(6, 8), 10);
  const date = new Date(Date.UTC(year, month, day));

  if (Number.isNaN(date.getTime())) {
    return null;
  }

  return date;
}

function getLogFilePath(prefix, timestamp = new Date()) {
  const windowStart = getRotationWindowStart(timestamp);
  const stamp = formatDateStamp(windowStart);
  return path.join(LOG_DIR, `${prefix}-${stamp}.log`);
}

function getCategoryPrefixes(level) {
  const categories = ['container'];

  if (level === 'ERROR') {
    categories.push('app', 'error');
    return categories;
  }

  if (level === 'DEBUG') {
    categories.push('debug');
    return categories;
  }

  if (level === 'ACCESS') {
    categories.push('access');
    return categories;
  }

  categories.push('app');
  return categories;
}

function pruneOldLogs() {
  const cutoff = Date.now() - (LOG_RETENTION_DAYS * DAY_MS);
  const files = fs.readdirSync(LOG_DIR, { withFileTypes: true });

  for (const entry of files) {
    if (!entry.isFile()) {
      continue;
    }

    const match = /^(container|app|error|debug|access)-(\d{8})\.log$/.exec(entry.name);
    if (!match) {
      continue;
    }

    const prefix = match[1];
    const stamp = match[2];
    if (!LOG_PREFIXES.has(prefix)) {
      continue;
    }

    const fileWindowStart = parseDateStamp(stamp);
    if (!fileWindowStart) {
      continue;
    }

    const fileWindowEnd = fileWindowStart.getTime() + (LOG_ROTATION_DAYS * DAY_MS);
    if (fileWindowEnd < cutoff) {
      fs.rmSync(path.join(LOG_DIR, entry.name), { force: true });
    }
  }
}

function writeToFile(level, line) {
  if (!fileLoggingReady) {
    return;
  }

  const categories = getCategoryPrefixes(level);
  for (const category of categories) {
    const filePath = getLogFilePath(category);
    try {
      fs.appendFileSync(filePath, `${line}\n`, 'utf8');
    } catch (err) {
      // Fall back silently to console logging if file writing fails.
      fileLoggingReady = false;
      console.error(`[ERROR] ${new Date().toISOString()} - Failed to write log file (${filePath}): ${err.message}`);
      break;
    }
  }
}

function normalizeMessage(msg, args = []) {
  const base = typeof msg === 'string' ? msg : util.inspect(msg, { depth: null, breakLength: Infinity });
  if (args.length === 0) {
    return base;
  }

  const serializedArgs = args.map((arg) => {
    if (typeof arg === 'string') {
      return arg;
    }

    return util.inspect(arg, { depth: null, breakLength: Infinity });
  });

  return `${base} ${serializedArgs.join(' ')}`;
}

function formatLine(level, message) {
  return `[${level}] ${new Date().toISOString()} - ${message}`;
}

function log(level, msg, consoleFn = console.log, ...args) {
  const message = normalizeMessage(msg, args);
  const line = formatLine(level, message);
  consoleFn(line);
  writeToFile(level, line);
}

initializeFileLogging();

const logger = {
  /**
   * Log debug message (only in debug mode)
   * @param {string} msg - Message to log
   */
  debug: (msg, ...args) => {
    if (DEBUG_MODE) {
      log('DEBUG', msg, console.log, ...args);
    }
  },

  /**
   * Log warning message
   * @param {string} msg - Message to log
   */
  warn: (msg, ...args) => log('WARN', msg, console.warn, ...args),

  /**
   * Log informational message
   * @param {string} msg - Message to log
   */
  info: (msg, ...args) => log('INFO', msg, console.log, ...args),

  /**
   * Log error message
   * @param {string} msg - Message to log
   */
  error: (msg, ...args) => log('ERROR', msg, console.error, ...args),

  /**
   * Log success message
   * @param {string} msg - Message to log
   */
  success: (msg, ...args) => log('SUCCESS', msg, console.log, ...args),

  /**
   * Log HTTP access message
   * @param {string} msg - Message to log
   */
  access: (msg, ...args) => {
    if (!ACCESS_LOG_ENABLED) {
      return;
    }

    log('ACCESS', msg, console.log, ...args);
  }
};

module.exports = logger;