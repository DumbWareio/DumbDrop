/**
 * Security middleware implementations for HTTP-level protection.
 * Sets security headers (CSP, HSTS) and implements PIN-based authentication.
 * Provides Express middleware for securing routes and responses.
 */

const { safeCompare } = require('../utils/security');
const logger = require('../utils/logger');
const { config } = require('../config');

/**
 * Security headers middleware
 */
function securityHeaders(req, res, next) {
  // Content Security Policy
  let csp =
    "default-src 'self'; " +
    "connect-src 'self'; " +
    "style-src 'self' 'unsafe-inline' cdn.jsdelivr.net; " +
    "script-src 'self' 'unsafe-inline' cdn.jsdelivr.net; " +
    "img-src 'self' data: blob:;";

  // If allowedIframeOrigins is set, allow those origins to embed via iframe
  if (config.allowedIframeOrigins && config.allowedIframeOrigins.length > 0) {
    // Remove X-Frame-Options header (do not set it)
    // Add frame-ancestors directive to CSP
    const frameAncestors = ["'self'", ...config.allowedIframeOrigins].join(' ');
    csp += ` frame-ancestors ${frameAncestors};`;
  } else {
    // Default: only allow same origin if not configured
    res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  }

  res.setHeader('Content-Security-Policy', csp);
  res.setHeader('X-Content-Type-Options', 'nosniff');
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
      // Set cookie for subsequent requests with enhanced security
      const cookieOptions = {
        httpOnly: true, // Always enable HttpOnly
        secure: req.secure || req.headers['x-forwarded-proto'] === 'https', // Enable secure flag only if the request is over HTTPS
        sameSite: 'strict',
        path: '/',
        maxAge: 24 * 60 * 60 * 1000 // 24 hour expiry
      };
      
      res.cookie('DUMBDROP_PIN', headerPin, cookieOptions);
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