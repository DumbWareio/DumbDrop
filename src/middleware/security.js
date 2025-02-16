/**
 * Security middleware implementations for HTTP-level protection.
 * Sets security headers (CSP, HSTS) and implements PIN-based authentication.
 * Provides Express middleware for securing routes and responses.
 */

const { safeCompare } = require('../utils/security');
const logger = require('../utils/logger');

/**
 * Security headers middleware
 */
function securityHeaders(req, res, next) {
  // Content Security Policy
  res.setHeader(
    'Content-Security-Policy',
    "default-src 'self'; " +
    "style-src 'self' 'unsafe-inline' cdn.jsdelivr.net; " +
    "script-src 'self' 'unsafe-inline' cdn.jsdelivr.net; " +
    "img-src 'self' data: blob:;"
  );
  
  // X-Content-Type-Options
  res.setHeader('X-Content-Type-Options', 'nosniff');
  
  // X-Frame-Options
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  
  // X-XSS-Protection
  res.setHeader('X-XSS-Protection', '1; mode=block');
  
  // Strict Transport Security (when in production)
  if (process.env.NODE_ENV === 'production') {
    res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  }
  
  next();
}

/**
 * PIN protection middleware
 * @param {string} PIN - Valid PIN for comparison
 */
function requirePin(PIN) {
  return (req, res, next) => {
    // Skip PIN check if no PIN is configured
    if (!PIN) {
      return next();
    }

    // Check cookie first
    const cookiePin = req.cookies?.DUMBDROP_PIN;
    if (cookiePin && safeCompare(cookiePin, PIN)) {
      return next();
    }

    // Check header as fallback
    const headerPin = req.headers['x-pin'];
    if (headerPin && safeCompare(headerPin, PIN)) {
      // Set cookie for subsequent requests
      res.cookie('DUMBDROP_PIN', headerPin, {
        httpOnly: true,
        secure: process.env.NODE_ENV === 'production',
        sameSite: 'strict',
        path: '/'
      });
      return next();
    }

    logger.warn(`Unauthorized access attempt from IP: ${req.ip}`);
    res.status(401).json({ error: 'Unauthorized' });
  };
}

module.exports = {
  securityHeaders,
  requirePin
}; 