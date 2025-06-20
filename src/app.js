/**
 * Main application setup and configuration.
 * Initializes Express app, middleware, routes, and static file serving.
 * Handles core application bootstrapping and configuration validation.
 * Imports and makes use of the configured storage adapter.
 */

const express = require('express');
const cors = require('cors');
const cookieParser = require('cookie-parser');
const path = require('path');
const fs = require('fs'); // Needed for reading HTML templates

// Load configuration FIRST
const { config, validateConfig } = require('./config');
const logger = require('./utils/logger');
// Validate config EARLY, before loading anything else that depends on it
try {
    validateConfig();
    logger.info("Configuration loaded and validated successfully.");
} catch (validationError) {
     logger.error("!!! Configuration validation failed. Server cannot start. !!!");
     logger.error(validationError.message);
     process.exit(1); // Exit if config is invalid
}

// Load storage adapter AFTER config is validated
// The storage/index.js file itself will log which adapter is being used.
const { storageAdapter } = require('./storage'); // This will load the correct adapter

// Load other utilities and middleware
// const { ensureDirectoryExists } = require('./utils/fileUtils'); // No longer needed here
const { securityHeaders, requirePin } = require('./middleware/security');
const { safeCompare } = require('./utils/security');
const { initUploadLimiter, pinVerifyLimiter, downloadLimiter } = require('./middleware/rateLimiter');
const { injectDemoBanner, demoMiddleware } = require('./utils/demoMode');

// Create Express app
const app = express();

// Trust proxy headers (important for rate limiting and secure cookies if behind proxy)
app.set('trust proxy', 1); // Adjust the number based on your proxy setup depth

// Middleware setup
app.use(cors({
  origin: function (origin, callback) {
    // Allow requests with no origin (like mobile apps, Postman)
    if (!origin) return callback(null, true);
    
    if (config.allowedOrigins.indexOf(origin) !== -1) {
      return callback(null, true);
    } else {
      logger.warn(`CORS blocked request from origin: ${origin}`);
      return callback(new Error('Not allowed by CORS'));
    }
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Pin', 'X-Batch-ID']
}));
app.use(cookieParser());
app.use(express.json()); // For parsing application/json
app.use(securityHeaders); // Apply security headers

// --- Demo Mode Middleware ---
// Apply demo middleware early if demo mode is active
// Note: Demo mode is now also checked within adapters/storage factory
if (config.isDemoMode) {
    app.use(demoMiddleware); // This might intercept routes if demoAdapter is fully implemented
}

// --- Route Definitions ---
// Import route handlers AFTER middleware setup
// Note: uploadRouter is now an object { router }, so destructure it
const { router: uploadRouter } = require('./routes/upload');
const fileRoutes = require('./routes/files');
const authRoutes = require('./routes/auth');

// Apply Rate Limiting and Auth Middleware to Routes
app.use('/api/auth', pinVerifyLimiter, authRoutes);
// Apply PIN check and rate limiting to upload/file routes
// The requirePin middleware now checks config.pin internally
app.use('/api/upload', requirePin(config.pin), initUploadLimiter, uploadRouter);
app.use('/api/files', requirePin(config.pin), downloadLimiter, fileRoutes);


// --- Frontend Routes (Serving HTML) ---

// Root route ('/')
app.get('/', (req, res) => {
  // Redirect to login if PIN is required and not authenticated
  if (config.pin && (!req.cookies?.DUMBDROP_PIN || !safeCompare(req.cookies.DUMBDROP_PIN, config.pin))) {
    logger.debug('[/] PIN required, redirecting to login.html');
    return res.redirect('/login.html'); // Use relative path
  }

  try {
    const filePath = path.join(__dirname, '../public', 'index.html');
    let html = fs.readFileSync(filePath, 'utf8');

    // Perform template replacements
    html = html.replace(/{{SITE_TITLE}}/g, config.siteTitle);
    html = html.replace('{{AUTO_UPLOAD}}', config.autoUpload.toString());
    html = html.replace('{{MAX_RETRIES}}', config.clientMaxRetries.toString());
    // Ensure baseUrl has a trailing slash
    const baseUrlWithSlash = config.baseUrl.endsWith('/') ? config.baseUrl : config.baseUrl + '/';
    html = html.replace(/{{BASE_URL}}/g, baseUrlWithSlash);

    // Generate Footer Content
    let footerHtml = '';
    if (config.footerLinks && config.footerLinks.length > 0) {
        footerHtml = config.footerLinks.map(link =>
            `<a href="${link.url}" target="_blank" rel="noopener noreferrer">${link.text}</a>`
        ).join('<span class="footer-separator"> | </span>');
    } else {
        footerHtml = `<span class="footer-static">Built by <a href="https://www.dumbware.io/" target="_blank" rel="noopener noreferrer">Dumbwareio</a></span>`;
    }
    html = html.replace('{{FOOTER_CONTENT}}', footerHtml);

    // Inject Demo Banner if needed
    html = injectDemoBanner(html);

    res.setHeader('Content-Type', 'text/html');
    res.send(html);
  } catch (err) {
    logger.error(`Error processing index.html: ${err.message}`);
    res.status(500).send('Error loading page');
  }
});

// Login route ('/login.html')
app.get('/login.html', (req, res) => {
  // Prevent caching of the login page
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate, private');
  res.set('Pragma', 'no-cache');
  res.set('Expires', '0');

  try {
      const filePath = path.join(__dirname, '../public', 'login.html');
      let html = fs.readFileSync(filePath, 'utf8');
      html = html.replace(/{{SITE_TITLE}}/g, config.siteTitle);
      const baseUrlWithSlash = config.baseUrl.endsWith('/') ? config.baseUrl : config.baseUrl + '/';
      html = html.replace(/{{BASE_URL}}/g, baseUrlWithSlash);
      html = injectDemoBanner(html); // Inject demo banner if needed

      res.setHeader('Content-Type', 'text/html');
      res.send(html);
  } catch (err) {
       logger.error(`Error processing login.html: ${err.message}`);
       res.status(500).send('Error loading login page');
  }
});

// Health check endpoint (for monitoring and load balancers)
app.get('/health', (req, res) => {
  res.status(200).json({ status: 'OK', timestamp: new Date().toISOString() });
});

// Serve toastify files from node_modules (must come before general static files)
app.use('/toastify', express.static(path.join(__dirname, '../node_modules/toastify-js/src')));

// Serve remaining static files
app.use(express.static(path.join(__dirname, '../public')));

// Error handling middleware
app.use((err, req, res, next) => { // eslint-disable-line no-unused-vars
  logger.error(`Unhandled application error: ${err.message}`, err.stack);
  // Avoid sending stack trace in production
  const errorResponse = {
    message: 'Internal Server Error',
    ...(config.nodeEnv === 'development' && { error: err.message, stack: err.stack })
  };
  // Ensure response is sent only once
  if (!res.headersSent) {
     res.status(err.status || 500).json(errorResponse);
  }
});

// --- Initialize Function (Simplified) ---
/**
 * Initialize the application.
 * Placeholder function, as most initialization is now handled
 * by config loading, adapter loading, and server startup.
 * Could be used for other async setup tasks if needed later.
 */
async function initialize() {
  try {
    // Config validation happens at the top level now.
    // Storage adapter is loaded at the top level now.
    // Directory checks are handled within adapters/config.

    logger.info('Application initialized.');
    // Example: Log active storage type
    logger.info(`Active Storage Adapter: ${storageAdapter.constructor.name || config.storageType}`);

    return app; // Return the configured Express app instance
  } catch (err) {
    logger.error(`Application initialization failed: ${err.message}`);
    throw err; // Propagate error to stop server start
  }
}

module.exports = { app, initialize, config }; // Export app, initialize, and config