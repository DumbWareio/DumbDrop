/**
 * Logger utility for consistent logging across the application
 * Provides standardized timestamp and log level formatting
 */
const logger = {
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