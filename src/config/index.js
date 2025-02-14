require('dotenv').config();
const { validatePin } = require('../utils/security');
const logger = require('../utils/logger');
const fs = require('fs');

/**
 * Get the host path from Docker mount point
 * @returns {string} Host path or fallback to container path
 */
function getHostPath() {
  try {
    // Read Docker mountinfo to get the host path
    const mountInfo = fs.readFileSync('/proc/self/mountinfo', 'utf8');
    const lines = mountInfo.split('\n');
    
    // Find the line containing our upload directory
    const uploadMount = lines.find(line => line.includes('/app/uploads'));
    if (uploadMount) {
      // Extract the host path from the mount info
      const parts = uploadMount.split(' ');
      // The host path is typically in the 4th space-separated field
      const hostPath = parts[3];
      return hostPath;
    }
  } catch (err) {
    logger.debug('Could not determine host path from mount info');
  }
  
  // Fallback to container path if we can't determine host path
  return '/app/uploads';
}

/**
 * Application configuration
 * Loads and validates environment variables
 */
const config = {
  // Server settings
  port: process.env.PORT || 3000,
  nodeEnv: process.env.NODE_ENV || 'development',
  
  // Upload settings
  uploadDir: '/app/uploads', // Internal Docker path
  uploadDisplayPath: getHostPath(), // Dynamically determined from Docker mount
  maxFileSize: (() => {
    const sizeInMB = parseInt(process.env.MAX_FILE_SIZE || '1024', 10);
    if (isNaN(sizeInMB) || sizeInMB <= 0) {
      throw new Error('MAX_FILE_SIZE must be a positive number');
    }
    return sizeInMB * 1024 * 1024; // Convert MB to bytes
  })(),
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
      logger.info('Notifications disabled - No Configuration');
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