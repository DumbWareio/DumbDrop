const rateLimit = require('express-rate-limit');

/**
 * Rate limiter for upload initialization
 * Prevents abuse of the upload system
 */
const initUploadLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute window
  max: 30, // 30 new upload initializations per minute
  message: { 
    error: 'Too many upload attempts. Please wait before starting new uploads.' 
  },
  standardHeaders: true,
  legacyHeaders: false
});

/**
 * Rate limiter for PIN verification attempts
 * Prevents brute force attacks
 */
const pinVerifyLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 10, // 10 attempts per 15 minutes
  message: {
    error: 'Too many PIN verification attempts. Please try again later.'
  },
  standardHeaders: true,
  legacyHeaders: false
});

/**
 * Rate limiter for file downloads
 * Prevents abuse of the download system
 */
const downloadLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute window
  max: 60, // 60 downloads per minute
  message: {
    error: 'Too many download attempts. Please try again later.'
  },
  standardHeaders: true,
  legacyHeaders: false
});

module.exports = {
  initUploadLimiter,
  pinVerifyLimiter,
  downloadLimiter
}; 