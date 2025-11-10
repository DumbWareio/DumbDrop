const rateLimit = require('express-rate-limit');
const { registerCleanupTask } = require('../utils/cleanup');
const { getClientIp } = require('../utils/ipExtractor');

// Create rate limiters
const createLimiter = (options) => {
  const limiter = rateLimit(options);
  // Register cleanup for the rate limiter's store
  if (limiter.store && typeof limiter.store.resetAll === 'function') {
    registerCleanupTask(async () => {
      await limiter.store.resetAll();
    });
  }
  return limiter;
};

/**
 * Rate limiter for upload initialization
 * Limits the number of new upload jobs/batches that can be started
 * Does not limit the number of files within a batch or chunks within a file
 */
const initUploadLimiter = createLimiter({
  windowMs: 60 * 1000, // 1 minute window
  max: 30, // 30 upload jobs per minute
  message: { 
    error: 'Too many upload jobs started. Please wait before starting new uploads.' 
  },
  standardHeaders: true,
  legacyHeaders: false,
  // Use secure IP extraction to prevent header spoofing
  keyGenerator: (req) => getClientIp(req),
  // Skip rate limiting for chunk uploads within an existing batch
  skip: (req) => {
    return req.headers['x-batch-id'] !== undefined;
  }
});

/**
 * Rate limiter for chunk uploads
 * More permissive to allow large file uploads
 */
const chunkUploadLimiter = createLimiter({
  windowMs: 60 * 1000, // 1 minute window
  max: 300, // 300 chunks per minute (5 per second)
  message: {
    error: 'Upload rate limit exceeded. Please wait before continuing.'
  },
  standardHeaders: true,
  legacyHeaders: false,
  // Use secure IP extraction to prevent header spoofing
  keyGenerator: (req) => getClientIp(req)
});

/**
 * Rate limiter for PIN verification attempts
 * Prevents brute force attacks on actual PIN verification
 */
const pinVerifyLimiter = createLimiter({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 5, // 5 attempts per 15 minutes
  message: {
    error: 'Too many PIN verification attempts. Please try again later.'
  },
  standardHeaders: true,
  legacyHeaders: false,
  // Use secure IP extraction to prevent header spoofing
  keyGenerator: (req) => getClientIp(req),
  // Apply strict rate limiting only to PIN verification, not PIN status checks
  skip: (req) => {
    return req.path === '/pin-required'; // Skip rate limiting for PIN requirement checks
  }
});

/**
 * Rate limiter for PIN status checks
 * More permissive for checking if PIN is required
 */
const pinStatusLimiter = createLimiter({
  windowMs: 60 * 1000, // 1 minute window
  max: 30, // 30 requests per minute
  message: {
    error: 'Too many requests. Please wait before trying again.'
  },
  standardHeaders: true,
  legacyHeaders: false,
  // Use secure IP extraction to prevent header spoofing
  keyGenerator: (req) => getClientIp(req)
});

/**
 * Rate limiter for file downloads
 * Prevents abuse of the download system
 */
const downloadLimiter = createLimiter({
  windowMs: 60 * 1000, // 1 minute window
  max: 60, // 60 downloads per minute
  message: {
    error: 'Download rate limit exceeded. Please wait before downloading more files.'
  },
  standardHeaders: true,
  legacyHeaders: false,
  // Use secure IP extraction to prevent header spoofing
  keyGenerator: (req) => getClientIp(req)
});

module.exports = {
  initUploadLimiter,
  chunkUploadLimiter,
  pinVerifyLimiter,
  pinStatusLimiter,
  downloadLimiter
}; 