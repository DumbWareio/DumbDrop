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
  // Check if the PIN is configured and the cookie exists
  if (config.pin && (!req.cookies?.DUMBDROP_PIN || !safeCompare(req.cookies.DUMBDROP_PIN, config.pin))) {
    return res.redirect('/login.html');
  }
  
  let html = fs.readFileSync(path.join(__dirname, '../public', 'index.html'), 'utf8');
  html = html.replace(/{{SITE_TITLE}}/g, config.siteTitle);
  html = html.replace('{{AUTO_UPLOAD}}', config.autoUpload.toString());
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
    if (req.path === 'index.html') {
      html = html.replace('{{AUTO_UPLOAD}}', config.autoUpload.toString());
    }
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
  res.status(500).json({ 
    message: 'Internal server error', 
    error: process.env.NODE_ENV === 'development' ? err.message : undefined 
  });
});

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