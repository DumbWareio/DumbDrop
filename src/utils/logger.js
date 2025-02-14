/**
 * Logger utility for consistent logging across the application
 * Provides standardized timestamp and log level formatting
 */

// Debug mode can be enabled via environment variable
const DEBUG_MODE = process.env.DEBUG === 'true' || process.env.NODE_ENV === 'development';

const logger = {
  /**
   * Log debug message (only in debug mode)
   * @param {string} msg - Message to log
   */
  debug: (msg) => {
    if (DEBUG_MODE) {
      console.log(`[DEBUG] ${new Date().toISOString()} - ${msg}`);
    }
  },

  /**
   * Log warning message
   * @param {string} msg - Message to log
   */
  warn: (msg) => console.warn(`[WARN] ${new Date().toISOString()} - ${msg}`),

  /**
   * Log informational message
   * @param {string} msg - Message to log
   */
  info: (msg) => console.log(`[INFO] ${new Date().toISOString()} - ${msg}`),

  /**
   * Log error message
   * @param {string} msg - Message to log
   */
  error: (msg) => console.error(`[ERROR] ${new Date().toISOString()} - ${msg}`),

  /**
   * Log success message
   * @param {string} msg - Message to log
   */
  success: (msg) => console.log(`[SUCCESS] ${new Date().toISOString()} - ${msg}`)
};

module.exports = logger; 