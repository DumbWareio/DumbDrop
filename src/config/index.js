require('dotenv').config();
const { validatePin } = require('../utils/security');

/**
 * Application configuration
 * Loads and validates environment variables
 */
const config = {
  // Server settings
  port: process.env.PORT || 3000,
  nodeEnv: process.env.NODE_ENV || 'development',
  
  // Upload settings
  uploadDir: process.env.UPLOAD_DIR || './uploads',
  maxFileSize: parseInt(process.env.MAX_FILE_SIZE || '1024') * 1024 * 1024, // Convert MB to bytes
  autoUpload: process.env.AUTO_UPLOAD === 'true',
  
  // Security
  pin: validatePin(process.env.DUMBDROP_PIN),
  
  // UI settings
  siteTitle: process.env.DUMBDROP_TITLE || 'DumbDrop',
  
  // Notification settings
  appriseUrl: process.env.APPRISE_URL,
  appriseMessage: process.env.APPRISE_MESSAGE || 'New file uploaded - {filename} ({size}), Storage used {storage}',
  appriseSizeUnit: process.env.APPRISE_SIZE_UNIT,
  
  // File extensions
  allowedExtensions: process.env.ALLOWED_EXTENSIONS ? 
    process.env.ALLOWED_EXTENSIONS.split(',').map(ext => ext.trim().toLowerCase()) : 
    null
};

// Validate required settings
function validateConfig() {
  const errors = [];
  
  if (config.maxFileSize <= 0) {
    errors.push('MAX_FILE_SIZE must be greater than 0');
  }
  
  if (config.nodeEnv === 'production') {
    if (!config.appriseUrl) {
      console.warn('Warning: APPRISE_URL not set in production environment');
    }
  }
  
  if (errors.length > 0) {
    throw new Error('Configuration validation failed:\n' + errors.join('\n'));
  }
}

// Freeze configuration to prevent modifications
Object.freeze(config);

module.exports = {
  config,
  validateConfig
}; 