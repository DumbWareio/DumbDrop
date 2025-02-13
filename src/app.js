const express = require('express');
const cors = require('cors');
const cookieParser = require('cookie-parser');
const path = require('path');
const fs = require('fs');

const { config, validateConfig } = require('./config');
const logger = require('./utils/logger');
const { ensureDirectoryExists } = require('./utils/fileUtils');
const { securityHeaders, requirePin } = require('./middleware/security');
const { initUploadLimiter, pinVerifyLimiter, downloadLimiter } = require('./middleware/rateLimiter');

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
const uploadRoutes = require('./routes/upload');
const fileRoutes = require('./routes/files');
const authRoutes = require('./routes/auth');

// Use routes with appropriate middleware
app.use('/api/auth', pinVerifyLimiter, authRoutes);
app.use('/api/upload', requirePin(config.pin), initUploadLimiter, uploadRoutes);
app.use('/api/files', requirePin(config.pin), downloadLimiter, fileRoutes);

// Root route
app.get('/', (req, res) => {
  if (config.pin && !req.cookies.DUMBDROP_PIN) {
    return res.redirect('/login.html');
  }
  
  let html = fs.readFileSync(path.join(__dirname, '../public', 'index.html'), 'utf8');
  html = html.replace(/{{SITE_TITLE}}/g, config.siteTitle);
  html = html.replace('{{AUTO_UPLOAD}}', config.autoUpload.toString());
  res.send(html);
});

// Login route
app.get('/login.html', (req, res) => {
  let html = fs.readFileSync(path.join(__dirname, '../public', 'login.html'), 'utf8');
  html = html.replace(/{{SITE_TITLE}}/g, config.siteTitle);
  res.send(html);
});

// Serve static files
app.use(express.static('public'));

// Error handling middleware
app.use((err, req, res, next) => {
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
    
    return app;
  } catch (err) {
    logger.error(`Initialization failed: ${err.message}`);
    throw err;
  }
}

module.exports = { app, initialize, config }; 