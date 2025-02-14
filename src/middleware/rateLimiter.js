const rateLimit = require('express-rate-limit');

/**
 * Rate limiter for upload initialization
 * Limits the number of new upload jobs/batches that can be started
 * Does not limit the number of files within a batch or chunks within a file
 */
const initUploadLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute window
  max: 30, // 30 upload jobs per minute
  message: { 
    error: 'Too many upload jobs started. Please wait before starting new uploads.' 
  },
  standardHeaders: true,
  legacyHeaders: false,
  // Skip rate limiting for chunk uploads within an existing batch
  skip: (req, res) => {
    return req.headers['x-batch-id'] !== undefined;
  }
});

/**
 * Rate limiter for chunk uploads
 * More permissive to allow large file uploads
 */
const chunkUploadLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute window
  max: 300, // 300 chunks per minute (5 per second)
  message: {
    error: 'Upload rate limit exceeded. Please wait before continuing.'
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
  chunkUploadLimiter,
  pinVerifyLimiter,
  downloadLimiter
}; 