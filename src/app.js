/**
 * Main application setup and configuration.
 * Initializes Express app, middleware, routes, and static file serving.
 * Handles core application bootstrapping and configuration validation.
 */

const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const cookieParser = require('cookie-parser');
const path = require('path');
const fs = require('fs');
const fsPromises = require('fs').promises;

const { config, validateConfig } = require('./config');
const logger = require('./utils/logger');
const { ensureDirectoryExists, isPathWithinUploadDir } = require('./utils/fileUtils');
const { getHelmetConfig, requirePin } = require('./middleware/security');
const { safeCompare } = require('./utils/security');
const { initUploadLimiter, pinVerifyLimiter, pinStatusLimiter, downloadLimiter } = require('./middleware/rateLimiter');
const { injectDemoBanner, demoMiddleware } = require('./utils/demoMode');
const { originValidationMiddleware, getCorsOptions } = require('./middleware/cors');

function createSafeContentDisposition(filename) {
  const basename = path.basename(filename);
  // eslint-disable-next-line no-control-regex
  const sanitized = basename.replace(/[\u0000-\u001F\u007F"\\]/g, '_');

  if (/^[\u0020-\u007E]*$/.test(sanitized)) {
    const escaped = sanitized.replace(/["\\]/g, '\\$&');
    return `attachment; filename="${escaped}"`;
  }

  const encoded = encodeURIComponent(sanitized);
  const asciiSafe = sanitized.replace(/[^\u0020-\u007E]/g, '_');
  return `attachment; filename="${asciiSafe}"; filename*=UTF-8''${encoded}`;
}

const RESERVED_SHORT_LINK_PATHS = new Set([
  '',
  'api',
  'index.html',
  'login.html',
  'styles.css',
  'config.js',
  'manifest.json',
  'asset-manifest.json',
  'service-worker.js',
  'assets',
  'toastify'
]);

const RESERVED_SHORT_LINK_PREFIXES = ['api/', 'assets/', 'toastify/'];

// Create Express app
const app = express();
const PORT = process.env.PORT || 3000;
const BASE_URL = process.env.BASE_URL || `http://localhost:${PORT}`;

// Configure proxy trust based on environment (security-sensitive)
if (config.trustProxy) {
  if (config.trustedProxyIps && config.trustedProxyIps.length > 0) {
    // Trust only specific proxy IPs
    app.set('trust proxy', config.trustedProxyIps);
    logger.warn(`Proxy trust enabled for specific IPs: ${config.trustedProxyIps.join(', ')}`);
  } else {
    // Trust first proxy only
    app.set('trust proxy', 1);
    logger.warn('Proxy trust enabled for first proxy - ensure reverse proxy is properly configured');
  }
} else {
  // Secure default: do not trust proxy headers
  app.set('trust proxy', false);
  logger.info('Proxy trust disabled (secure default mode)');
}

// Middleware setup
app.use(cors(getCorsOptions(BASE_URL)));
app.use(cookieParser());
app.use(express.json());
app.use(helmet(getHelmetConfig()));

// Public short-link downloads, e.g. /mask.zip or /folder/mask.zip
app.get('/*', async (req, res, next) => {
  const rawPath = req.path.replace(/^\/+/, '');
  const normalizedPath = rawPath.toLowerCase();

  if (!rawPath || rawPath.endsWith('/')) return next();
  if (RESERVED_SHORT_LINK_PATHS.has(normalizedPath)) return next();
  if (RESERVED_SHORT_LINK_PREFIXES.some(prefix => normalizedPath.startsWith(prefix))) return next();

  let relativeUploadPath;
  try {
    relativeUploadPath = rawPath
      .split('/')
      .map(segment => decodeURIComponent(segment))
      .join('/');
  } catch {
    return next();
  }

  const filePath = path.join(config.uploadDir, relativeUploadPath);
  if (!isPathWithinUploadDir(filePath, config.uploadDir, true)) {
    return next();
  }

  try {
    const stats = await fsPromises.stat(filePath);
    if (!stats.isFile()) return next();

    res.setHeader('Content-Disposition', createSafeContentDisposition(relativeUploadPath));
    res.setHeader('Content-Type', 'application/octet-stream');

    const fileStream = fs.createReadStream(filePath);
    fileStream.pipe(res);
    fileStream.on('error', (err) => {
      logger.error(`Short-link file streaming error: ${err.message}`);
      if (!res.headersSent) {
        res.status(500).json({ error: 'Failed to download file' });
      }
    });
  } catch (err) {
    if (err.code === 'ENOENT' || err.code === 'ENOTDIR') {
      return next();
    }

    logger.error(`Short-link download failed: ${err.message}`);
    return res.status(500).json({ error: 'Failed to download file' });
  }
});

// --- AUTHENTICATION MIDDLEWARE FOR ALL PROTECTED ROUTES ---
app.use((req, res, next) => {
  // List of paths that should be publicly accessible
  const publicPaths = [
    '/login',
    '/login.html',
    '/api/auth/logout',
    '/api/auth/verify-pin',
    '/api/auth/pin-required',
    '/api/auth/pin-length',
    '/pin-length',
    '/verify-pin',
    '/config.js',
    '/assets/',
    '/styles.css',
    '/manifest.json',
    '/asset-manifest.json',
    '/toastify',
  ];

  // Check if the current path matches any of the public paths
  if (publicPaths.some(path => req.path.startsWith(path))) {
      return next();
  }

  // For all other paths, apply both origin validation and auth middleware
  originValidationMiddleware(req, res, () => {
    demoMiddleware(req, res, next);
  });
});

// Import routes
const { router: uploadRouter } = require('./routes/upload');
const fileRoutes = require('./routes/files');
const authRoutes = require('./routes/auth');

// Use routes with appropriate middleware
// Apply strict rate limiting to PIN verification, but more permissive to status checks
const filesPinMiddleware = requirePin(config.pin);
app.use('/api/auth/pin-required', pinStatusLimiter);
app.use('/api/auth/logout', pinStatusLimiter);
app.use('/api/auth', pinVerifyLimiter, authRoutes);
app.use('/api/upload', requirePin(config.pin), initUploadLimiter, uploadRouter);
app.use('/api/files', (req, res, next) => {
  if (req.path.startsWith('/download/')) {
    return next();
  }
  return filesPinMiddleware(req, res, next);
}, downloadLimiter, fileRoutes);

// Root route
app.get('/', (req, res) => {
  // Check if the PIN is configured and the cookie exists
  if (config.pin && (!req.cookies?.DUMBDROP_PIN || !safeCompare(req.cookies.DUMBDROP_PIN, config.pin))) {
    return res.redirect('/login.html');
  }
  
  let html = fs.readFileSync(path.join(__dirname, '../public', 'index.html'), 'utf8');
  html = html.replace(/{{SITE_TITLE}}/g, config.siteTitle);
  html = html.replace(/{{TERMS_LINK}}/g, config.termsLink || '');
  html = html.replace('{{AUTO_UPLOAD}}', config.autoUpload.toString());
  html = html.replace('{{MAX_RETRIES}}', config.clientMaxRetries.toString());
  html = html.replace('{{SHOW_FILE_LIST}}', config.showFileList.toString());
  html = injectDemoBanner(html);
  res.send(html);
});

// Login route
app.get('/login.html', (req, res) => {
  // Add cache control headers
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate, private');
  res.set('Pragma', 'no-cache');
  res.set('Expires', '0');
  
  let html = fs.readFileSync(path.join(__dirname, '../public', 'login.html'), 'utf8');
  html = html.replace(/{{SITE_TITLE}}/g, config.siteTitle);
  html = html.replace(/{{TERMS_LINK}}/g, config.termsLink || '');
  html = injectDemoBanner(html);
  res.send(html);
});

// Serve static files with template variable replacement for HTML files
app.use((req, res, next) => {
  if (!req.path.endsWith('.html')) {
    return next();
  }
  
  try {
    const filePath = path.join(__dirname, '../public', req.path);
    let html = fs.readFileSync(filePath, 'utf8');
    html = html.replace(/{{SITE_TITLE}}/g, config.siteTitle);
    html = html.replace(/{{TERMS_LINK}}/g, config.termsLink || '');
    if (req.path === '/index.html' || req.path === 'index.html') {
      html = html.replace('{{AUTO_UPLOAD}}', config.autoUpload.toString());
      html = html.replace('{{MAX_RETRIES}}', config.clientMaxRetries.toString());
      html = html.replace('{{SHOW_FILE_LIST}}', config.showFileList.toString());
    }
    // Ensure baseUrl has a trailing slash
    const baseUrlWithSlash = config.baseUrl.endsWith('/') ? config.baseUrl : config.baseUrl + '/';
    html = html.replace(/{{BASE_URL}}/g, baseUrlWithSlash);
    html = injectDemoBanner(html);
    res.send(html);
  } catch {
    next();
  }
});

// Serve remaining static files
app.use(express.static('public'));
// Serve Toastify assets under /toastify
app.use('/toastify', express.static(path.join(__dirname, '../node_modules/toastify-js/src')));

// Error handling middleware
// Express requires all 4 parameters for error handling middleware
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  logger.error(`Unhandled error: ${err.message}`);
  res.status(500).json({ 
    message: 'Internal server error', 
    error: process.env.NODE_ENV === 'development' ? err.message : undefined 
  });
});

// --- Add this after config is loaded ---
const METADATA_DIR = path.join(config.uploadDir, '.metadata');
// --- End addition ---

/**
 * Initialize the application
 * Sets up required directories and validates configuration
 */
async function initialize() {
  try {
    // Validate configuration
    validateConfig();
    
    // Ensure upload directory exists and is writable
    await ensureDirectoryExists(config.uploadDir);

    // --- Add this section ---
    // Ensure metadata directory exists
    try {
        if (!fs.existsSync(METADATA_DIR)) {
            await fsPromises.mkdir(METADATA_DIR, { recursive: true });
            logger.info(`Created metadata directory: ${METADATA_DIR}`);
        } else {
            logger.info(`Metadata directory exists: ${METADATA_DIR}`);
        }
         // Check writability (optional but good practice)
        await fsPromises.access(METADATA_DIR, fs.constants.W_OK);
         logger.success(`Metadata directory is writable: ${METADATA_DIR}`);
    } catch (err) {
        logger.error(`Metadata directory error (${METADATA_DIR}): ${err.message}`);
        // Decide if this is fatal. If resumability is critical, maybe throw.
        throw new Error(`Failed to access or create metadata directory: ${METADATA_DIR}`);
    }
    // --- End added section ---
    
    // Log configuration
    logger.info(`Maximum file size set to: ${config.maxFileSize / (1024 * 1024)}MB`);
    if (config.pin) {
      logger.info('PIN protection enabled');
    }
    logger.info(`Auto upload is ${config.autoUpload ? 'enabled' : 'disabled'}`);
    if (config.appriseUrl) {
      logger.info('Apprise notifications enabled');
    }
    
    // After initializing demo middleware
    if (process.env.DEMO_MODE === 'true') {
        logger.info('[DEMO] Running in demo mode - uploads will not be saved');
        // Clear any existing files in upload directory
        try {
            const files = fs.readdirSync(config.uploadDir);
            for (const file of files) {
                fs.unlinkSync(path.join(config.uploadDir, file));
            }
            logger.info('[DEMO] Cleared upload directory');
        } catch (err) {
            logger.error(`[DEMO] Failed to clear upload directory: ${err.message}`);
        }
    }
    
    return app;
  } catch (err) {
    logger.error(`Initialization failed: ${err.message}`);
    throw err;
  }
}

module.exports = { app, initialize, config }; 