/**
 * Core security utilities for authentication and protection.
 * Implements rate limiting, PIN validation, and secure string comparison.
 * Manages login attempts and security-related cleanup tasks.
 */

const crypto = require('crypto');
const logger = require('./logger'); // Corrected path

/**
 * Store for login attempts with rate limiting
 * @type {Map<string, {count: number, lastAttempt: number}>}
 */
const loginAttempts = new Map();

// Constants
const MAX_ATTEMPTS = 5;
const LOCKOUT_DURATION = 15 * 60 * 1000; // 15 minutes

let cleanupInterval;

/**
 * Start the cleanup interval for old lockouts
 * @returns {NodeJS.Timeout} The interval handle
 */
function startCleanupInterval() {
  if (cleanupInterval) {
    clearInterval(cleanupInterval);
  }

  cleanupInterval = setInterval(() => {
    const now = Date.now();
    let cleaned = 0;
    for (const [ip, attempts] of loginAttempts.entries()) {
      if (now - attempts.lastAttempt >= LOCKOUT_DURATION) {
        loginAttempts.delete(ip);
        cleaned++;
      }
    }
    if (cleaned > 0) {
      logger.info(`Cleaned up ${cleaned} expired lockouts`);
    }
  }, 60000); // Check every minute

  // Allow node to exit even if this interval is running
  cleanupInterval.unref();

  return cleanupInterval;
}

/**
 * Stop the cleanup interval
 */
function stopCleanupInterval() {
  if (cleanupInterval) {
    clearInterval(cleanupInterval);
    cleanupInterval = null;
  }
}

// Start cleanup interval unless disabled
if (!process.env.DISABLE_SECURITY_CLEANUP) {
  startCleanupInterval();
}

// Stop interval on shutdown signals
process.on('SIGTERM', stopCleanupInterval);
process.on('SIGINT', stopCleanupInterval);


/**
 * Reset login attempts for an IP
 * @param {string} ip - IP address
 */
function resetAttempts(ip) {
  loginAttempts.delete(ip);
  logger.info(`Reset login attempts for IP: ${ip}`);
}

/**
 * Check if an IP is locked out
 * @param {string} ip - IP address
 * @returns {boolean} True if IP is locked out
 */
function isLockedOut(ip) {
  const attempts = loginAttempts.get(ip);
  if (!attempts) return false;

  if (attempts.count >= MAX_ATTEMPTS) {
    const timeElapsed = Date.now() - attempts.lastAttempt;
    if (timeElapsed < LOCKOUT_DURATION) {
      return true;
    }
    // Lockout expired, reset attempts before proceeding
    resetAttempts(ip);
  }
  return false;
}

/**
 * Record a login attempt for an IP
 * @param {string} ip - IP address
 * @returns {{count: number, lastAttempt: number}} Attempt details
 */
function recordAttempt(ip) {
  const attempts = loginAttempts.get(ip) || { count: 0, lastAttempt: 0 };
  attempts.count += 1;
  attempts.lastAttempt = Date.now();
  loginAttempts.set(ip, attempts);
  logger.warn(`Recorded failed login attempt for IP: ${ip} (attempt ${attempts.count})`);
  return attempts;
}

/**
 * Validate and clean PIN
 * @param {string} pin - PIN to validate
 * @returns {string|null} Cleaned PIN or null if invalid
 */
function validatePin(pin) {
  if (!pin || typeof pin !== 'string') return null;
  // Remove non-digit characters
  const cleanPin = pin.replace(/\D/g, '');
  // Check length constraints (e.g., 4-10 digits)
  return cleanPin.length >= 4 && cleanPin.length <= 10 ? cleanPin : null;
}

/**
 * Compare two strings in constant time using crypto.timingSafeEqual
 * Pads strings to a fixed length to prevent timing attacks based on length.
 * @param {string} a - First string
 * @param {string} b - Second string
 * @returns {boolean} True if strings match
 */
function safeCompare(a, b) {
  // Ensure inputs are strings
  if (typeof a !== 'string' || typeof b !== 'string') {
    logger.warn('safeCompare received non-string input.');
    return false;
  }

  try {
    // Choose a fixed length significantly longer than expected max input length
    const fixedLength = 64;
    const bufferA = Buffer.alloc(fixedLength, 0); // Allocate buffer filled with zeros
    const bufferB = Buffer.alloc(fixedLength, 0);

    // Copy input strings into buffers, truncated if necessary
    bufferA.write(a.slice(0, fixedLength));
    bufferB.write(b.slice(0, fixedLength));

    // Perform timing-safe comparison
    return crypto.timingSafeEqual(bufferA, bufferB);
  } catch (err) {
    // Handle potential errors like if inputs are unexpectedly huge (though sliced above)
    logger.error(`Error during safeCompare: ${err.message}`);
    return false;
  }
}

module.exports = {
  MAX_ATTEMPTS,
  LOCKOUT_DURATION,
  resetAttempts,
  isLockedOut,
  recordAttempt,
  validatePin,
  safeCompare,
  startCleanupInterval,
  stopCleanupInterval
};