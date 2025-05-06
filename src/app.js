/**
 * Main application setup and configuration.
 * Initializes Express app, middleware, routes, and static file serving.
 * Handles core application bootstrapping and configuration validation.
 */

const express = require('express');
const cors = require('cors');
const cookieParser = require('cookie-parser');
const path = require('path');
const fs = require('fs');
const fsPromises = require('fs').promises;

const { config, validateConfig } = require('./config');
const logger = require('./utils/logger');
const { ensureDirectoryExists } = require('./utils/fileUtils');
const { securityHeaders, requirePin } = require('./middleware/security');
const { safeCompare } = require('./utils/security');
const { initUploadLimiter, pinVerifyLimiter, downloadLimiter } = require('./middleware/rateLimiter');
const { injectDemoBanner, demoMiddleware } = require('./utils/demoMode');

// Create Express app
const app = express();

// Add this line to trust the first proxy
app.set('trust proxy', 1);

// Middleware setup
app.use(cors());
app.use(cookieParser());
app.use(express.json());
app.use(securityHeaders);

// Import routes
const { router: uploadRouter } = require('./routes/upload');
const fileRoutes = require('./routes/files');
const authRoutes = require('./routes/auth');

// Add demo middleware before your routes
app.use(demoMiddleware);

// Use routes with appropriate middleware
app.use('/api/auth', pinVerifyLimiter, authRoutes);
app.use('/api/upload', requirePin(config.pin), initUploadLimiter, uploadRouter);
app.use('/api/files', requirePin(config.pin), downloadLimiter, fileRoutes);

// Root route
app.get('/', (req, res) => {
  try {
    // Check if the PIN is configured and the cookie exists
    if (config.pin && (!req.cookies?.DUMBDROP_PIN || !safeCompare(req.cookies.DUMBDROP_PIN, config.pin))) {
      return res.redirect('/login.html');
    }
    
    let html = fs.readFileSync(path.join(__dirname, '../public', 'index.html'), 'utf8');
    
    // Standard replacements
    html = html.replace(/{{SITE_TITLE}}/g, config.siteTitle);
    html = html.replace('{{AUTO_UPLOAD}}', config.autoUpload.toString());
    html = html.replace('{{MAX_RETRIES}}', config.clientMaxRetries.toString());
    // Ensure baseUrl has a trailing slash for correct asset linking
    const baseUrlWithSlash = config.baseUrl.endsWith('/') ? config.baseUrl : config.baseUrl + '/';
    html = html.replace(/{{BASE_URL}}/g, baseUrlWithSlash);
    
    // Generate Footer Content
    let footerHtml = ''; // Initialize empty
    if (config.footerLinks && config.footerLinks.length > 0) {
        // If custom links exist, use only them
        footerHtml = config.footerLinks.map(link => 
            `<a href="${link.url}" target="_blank" rel="noopener noreferrer">${link.text}</a>`
        ).join('<span class="footer-separator"> | </span>');
    } else {
        // Otherwise, use only the default static link
        footerHtml = `<span class="footer-static">Built by <a href="https://www.dumbware.io/" target="_blank" rel="noopener noreferrer">Dumbwareio</a></span>`;
    }
    html = html.replace('{{FOOTER_CONTENT}}', footerHtml);

    // Inject demo banner if applicable
    html = injectDemoBanner(html);

    // Send the final processed HTML
    res.send(html);

  } catch (err) {
    logger.error(`Error processing index.html for / route: ${err.message}`);
    // Check if headers have already been sent before trying to send an error response
    if (!res.headersSent) {
      res.status(500).send('Error loading page');
    }
  }
});

// Login route
app.get('/login.html', (req, res) => {
  // Add cache control headers
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate, private');
  res.set('Pragma', 'no-cache');
  res.set('Expires', '0');
  
  let html = fs.readFileSync(path.join(__dirname, '../public', 'login.html'), 'utf8');
  html = html.replace(/{{SITE_TITLE}}/g, config.siteTitle);
  // Ensure baseUrl has a trailing slash
  const baseUrlWithSlash = config.baseUrl.endsWith('/') ? config.baseUrl : config.baseUrl + '/';
  html = html.replace(/{{BASE_URL}}/g, baseUrlWithSlash);
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
    if (req.path === '/index.html' || req.path === 'index.html') {
      html = html.replace('{{AUTO_UPLOAD}}', config.autoUpload.toString());
      html = html.replace('{{MAX_RETRIES}}', config.clientMaxRetries.toString());
    }
    // Ensure baseUrl has a trailing slash
    const baseUrlWithSlash = config.baseUrl.endsWith('/') ? config.baseUrl : config.baseUrl + '/';
    html = html.replace(/{{BASE_URL}}/g, baseUrlWithSlash);
    html = injectDemoBanner(html);
    res.send(html);
  } catch (err) {
    next();
  }
});

// Serve remaining static files
app.use(express.static('public'));

// Error handling middleware
app.use((err, req, res, next) => { // eslint-disable-line no-unused-vars
  logger.error(`Unhandled error: ${err.message}`);
  // Check if headers have already been sent before trying to send an error response
  if (res.headersSent) {
    return next(err); // Pass error to default handler if headers sent
  }
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