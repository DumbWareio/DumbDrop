require('dotenv').config();
const { validatePin } = require('../utils/security');
const logger = require('../utils/logger'); // Use the default logger instance
const fs = require('fs');
const path = require('path');
const { version } = require('../../package.json'); // Get version from package.json

// --- Environment Variables Reference ---
/*
  STORAGE_TYPE          - Storage backend ('local' or 's3', default: 'local')
  // --- Local Storage ---
  UPLOAD_DIR            - Directory for uploads (Docker/production, if STORAGE_TYPE=local)
  LOCAL_UPLOAD_DIR      - Directory for uploads (local dev, fallback: './local_uploads', if STORAGE_TYPE=local)
  // --- S3 Storage ---
  S3_REGION             - AWS Region for S3 Bucket (required if STORAGE_TYPE=s3)
  S3_BUCKET_NAME        - Name of the S3 Bucket (required if STORAGE_TYPE=s3)
  S3_ACCESS_KEY_ID      - S3 Access Key ID (required if STORAGE_TYPE=s3)
  S3_SECRET_ACCESS_KEY  - S3 Secret Access Key (required if STORAGE_TYPE=s3)
  S3_ENDPOINT_URL       - Custom S3 endpoint URL (optional, for non-AWS S3)
  S3_FORCE_PATH_STYLE   - Force path-style access (true/false, optional, for non-AWS S3)
  // --- Common ---
  PORT                  - Port for the server (default: 3000)
  NODE_ENV              - Node environment (default: 'development')
  BASE_URL              - Base URL for the app (default: http://localhost:${PORT})
  MAX_FILE_SIZE         - Max upload size in MB (default: 1024)
  AUTO_UPLOAD           - Enable auto-upload (true/false, default: false)
  DUMBDROP_PIN          - Security PIN for uploads (required for protected endpoints)
  DUMBDROP_TITLE        - Site title (default: 'DumbDrop')
  APPRISE_URL           - Apprise notification URL (optional)
  APPRISE_MESSAGE       - Notification message template (default provided)
  APPRISE_SIZE_UNIT     - Size unit for notifications (optional)
  ALLOWED_EXTENSIONS    - Comma-separated list of allowed file extensions (optional)
  ALLOWED_IFRAME_ORIGINS- Comma-separated list of allowed iframe origins (optional)
  CLIENT_MAX_RETRIES    - Max retries for client chunk uploads (default: 5)
  DEMO_MODE             - Enable demo mode (true/false, default: false)
*/

// --- Helper for clear configuration logging ---
const logConfig = (message, level = 'info') => {
  const prefix = level === 'warning' ? '⚠️ WARNING:' : 'ℹ️ INFO:';
  console.log(`${prefix} CONFIGURATION: ${message}`);
};

// --- Default configurations ---
const DEFAULT_PORT = 3000;
const DEFAULT_SITE_TITLE = 'DumbDrop';
const DEFAULT_BASE_URL = 'http://localhost:3000';
const DEFAULT_CLIENT_MAX_RETRIES = 5;
const DEFAULT_STORAGE_TYPE = 'local';

const logAndReturn = (key, value, isDefault = false, sensitive = false) => {
  const displayValue = sensitive ? '********' : value;
  logConfig(`${key}: ${displayValue}${isDefault ? ' (default)' : ''}`);
  return value;
};

// --- Utility to detect if running in local development mode ---
// (This helps decide whether to *create* LOCAL_UPLOAD_DIR, but doesn't affect UPLOAD_DIR usage in Docker)
function isLocalDevelopment() {
  return process.env.NODE_ENV !== 'production' && !process.env.UPLOAD_DIR;
}

/**
 * Determine the local upload directory path.
 * Only relevant when STORAGE_TYPE is 'local'.
 * @returns {string|null} The path, or null if storage is not local.
 */
function determineLocalUploadDirectory() {
  if (process.env.STORAGE_TYPE && process.env.STORAGE_TYPE.toLowerCase() !== 'local') {
    return null; // Not using local storage
  }

  let uploadDir;
  if (process.env.UPLOAD_DIR) {
    uploadDir = process.env.UPLOAD_DIR;
    logger.info(`[Local Storage] Upload directory set from UPLOAD_DIR: ${uploadDir}`);
  } else if (process.env.LOCAL_UPLOAD_DIR) {
    uploadDir = process.env.LOCAL_UPLOAD_DIR;
    logger.warn(`[Local Storage] Upload directory using LOCAL_UPLOAD_DIR fallback: ${uploadDir}`);
  } else {
    uploadDir = './local_uploads'; // Default local path
    logger.warn(`[Local Storage] Upload directory using default fallback: ${uploadDir}`);
  }
  logger.info(`[Local Storage] Final upload directory path: ${path.resolve(uploadDir)}`);
  return uploadDir;
}

/**
 * Ensure the local upload directory exists (if applicable and in local dev).
 */
function ensureLocalUploadDirExists(dirPath) {
  if (!dirPath || !isLocalDevelopment()) {
    return; // Only create if using local storage in a local dev environment
  }
  try {
    if (!fs.existsSync(dirPath)) {
      fs.mkdirSync(dirPath, { recursive: true });
      logger.info(`[Local Storage] Created local upload directory: ${dirPath}`);
    } else {
      logger.info(`[Local Storage] Local upload directory exists: ${dirPath}`);
    }
    // Basic writability check
    fs.accessSync(dirPath, fs.constants.W_OK);
    logger.success(`[Local Storage] Local upload directory is writable: ${dirPath}`);
  } catch (err) {
    logger.error(`[Local Storage] Failed to create or access local upload directory: ${dirPath}. Error: ${err.message}`);
    throw new Error(`Upload directory "${dirPath}" is not accessible or writable.`);
  }
}

// --- Determine Storage Type ---
const storageTypeInput = process.env.STORAGE_TYPE || DEFAULT_STORAGE_TYPE;
const storageType = ['local', 's3'].includes(storageTypeInput.toLowerCase())
  ? storageTypeInput.toLowerCase()
  : DEFAULT_STORAGE_TYPE;

if (storageTypeInput.toLowerCase() !== storageType) {
  logger.warn(`Invalid STORAGE_TYPE "${storageTypeInput}", using default: "${storageType}"`);
}

// Determine and potentially ensure local upload directory
const resolvedLocalUploadDir = determineLocalUploadDirectory(); // Will be null if STORAGE_TYPE is 's3'
if (resolvedLocalUploadDir) {
  ensureLocalUploadDirExists(resolvedLocalUploadDir);
}

/**
 * Function to parse the FOOTER_LINKS environment variable
 * @param {string} linksString - The input string containing links
 * @returns {Array} - An array of objects containing text and URL
 */
const parseFooterLinks = (linksString) => {
  if (!linksString) return [];
  return linksString.split(',')
    .map(linkPair => {
      const parts = linkPair.split('@').map(part => part.trim());
      if (parts.length === 2 && parts[0] && parts[1] && (parts[1].startsWith('http://') || parts[1].startsWith('https://'))) {
        return { text: parts[0], url: parts[1] };
      } else {
        logger.warn(`Invalid format or URL in FOOTER_LINKS: "${linkPair}". Expected "Text @ http(s)://URL". Skipping.`);
        return null;
      }
    })
    .filter(link => link !== null);
};

/**
 * Application configuration
 * Loads and validates environment variables
 */
const config = {
  // =====================
  // Core Settings
  // =====================
  port: parseInt(process.env.PORT || DEFAULT_PORT, 10),
  nodeEnv: process.env.NODE_ENV || 'development',
  baseUrl: process.env.BASE_URL || `${DEFAULT_BASE_URL.replace(/:3000$/, '')}:${process.env.PORT || DEFAULT_PORT}/`, // Ensure trailing slash
  isDemoMode: process.env.DEMO_MODE === 'true',

  // =====================
  // Storage Settings
  // =====================
  storageType: logAndReturn('STORAGE_TYPE', storageType, storageType === DEFAULT_STORAGE_TYPE),
  /**
   * The primary directory for storing files or metadata.
   * If STORAGE_TYPE=local, this is where files are stored.
   * If STORAGE_TYPE=s3, this is where '.metadata' lives.
   * We default to the determined local path or a standard './uploads' if S3 is used.
   */
  uploadDir: resolvedLocalUploadDir || path.resolve('./uploads'), // S3 needs a place for metadata too

  // --- S3 Specific (only relevant if storageType is 's3') ---
  s3Region: process.env.S3_REGION || null,
  s3BucketName: process.env.S3_BUCKET_NAME || null,
  s3AccessKeyId: process.env.S3_ACCESS_KEY_ID || null,
  s3SecretAccessKey: process.env.S3_SECRET_ACCESS_KEY || null,
  s3EndpointUrl: process.env.S3_ENDPOINT_URL || null, // Default to null (AWS default endpoint)
  s3ForcePathStyle: process.env.S3_FORCE_PATH_STYLE === 'true', // Default to false

  // =====================
  // Upload Behavior
  // =====================
  maxFileSize: (() => {
    const sizeInMB = parseInt(process.env.MAX_FILE_SIZE || '1024', 10);
    if (isNaN(sizeInMB) || sizeInMB <= 0) {
      logger.error('Invalid MAX_FILE_SIZE, must be a positive number. Using 1024MB.');
      return 1024 * 1024 * 1024;
    }
    return sizeInMB * 1024 * 1024; // Convert MB to bytes
  })(),
  autoUpload: process.env.AUTO_UPLOAD === 'true',
  allowedExtensions: process.env.ALLOWED_EXTENSIONS ?
    process.env.ALLOWED_EXTENSIONS.split(',').map(ext => ext.trim().toLowerCase().replace(/^\./, '.')).filter(Boolean) : // Ensure dot prefix
    null,
  clientMaxRetries: (() => {
    const envValue = process.env.CLIENT_MAX_RETRIES;
    const defaultValue = DEFAULT_CLIENT_MAX_RETRIES;
    if (envValue === undefined) return logAndReturn('CLIENT_MAX_RETRIES', defaultValue, true);
    const retries = parseInt(envValue, 10);
    if (isNaN(retries) || retries < 0) {
      logger.warn(`Invalid CLIENT_MAX_RETRIES value: "${envValue}". Using default: ${defaultValue}`);
      return logAndReturn('CLIENT_MAX_RETRIES', defaultValue, true);
    }
    return logAndReturn('CLIENT_MAX_RETRIES', retries);
  })(),

  // =====================
  // Security
  // =====================
  pin: validatePin(process.env.DUMBDROP_PIN),
  allowedIframeOrigins: process.env.ALLOWED_IFRAME_ORIGINS ?
    process.env.ALLOWED_IFRAME_ORIGINS.split(',').map(origin => origin.trim()).filter(Boolean) :
    null,

  // =====================
  // UI & Notifications
  // =====================
  siteTitle: process.env.DUMBDROP_TITLE || DEFAULT_SITE_TITLE,
  footerLinks: parseFooterLinks(process.env.FOOTER_LINKS),
  appriseUrl: process.env.APPRISE_URL || null,
  appriseMessage: process.env.APPRISE_MESSAGE || 'New file uploaded - {filename} ({size}), Storage used {storage}',
  appriseSizeUnit: process.env.APPRISE_SIZE_UNIT || 'Auto',
};

// --- Log Sensitive & Conditional Config ---
logConfig(`NODE_ENV: ${config.nodeEnv}`);
logConfig(`PORT: ${config.port}`);
logConfig(`BASE_URL: ${config.baseUrl}`);
logConfig(`DEMO_MODE: ${config.isDemoMode}`);
if (config.storageType === 'local') {
  logConfig(`Upload Directory (Local): ${config.uploadDir}`);
} else {
  logConfig(`Metadata Directory (S3 Mode): ${config.uploadDir}`); // Clarify role in S3 mode
  logAndReturn('S3_REGION', config.s3Region);
  logAndReturn('S3_BUCKET_NAME', config.s3BucketName);
  logAndReturn('S3_ACCESS_KEY_ID', config.s3AccessKeyId, false, true); // Sensitive
  logAndReturn('S3_SECRET_ACCESS_KEY', config.s3SecretAccessKey, false, true); // Sensitive
  if (config.s3EndpointUrl) logAndReturn('S3_ENDPOINT_URL', config.s3EndpointUrl);
  logAndReturn('S3_FORCE_PATH_STYLE', config.s3ForcePathStyle);
}
logConfig(`Max File Size: ${config.maxFileSize / (1024 * 1024)}MB`);
logConfig(`Auto Upload: ${config.autoUpload}`);
if (config.allowedExtensions) logConfig(`Allowed Extensions: ${config.allowedExtensions.join(', ')}`);
if (config.pin) logAndReturn('DUMBDROP_PIN', config.pin, false, true); // Sensitive
if (config.allowedIframeOrigins) logConfig(`Allowed Iframe Origins: ${config.allowedIframeOrigins.join(', ')}`);
if (config.appriseUrl) logAndReturn('APPRISE_URL', config.appriseUrl);


// --- Configuration Validation ---
function validateConfig() {
  const errors = [];

  if (!config.port || config.port <= 0 || config.port > 65535) {
    errors.push('PORT must be a valid number between 1 and 65535');
  }

  if (config.maxFileSize <= 0) {
    errors.push('MAX_FILE_SIZE must be greater than 0');
  }

  // Validate BASE_URL format and trailing slash
  try {
    let url = new URL(config.baseUrl);
    if (!config.baseUrl.endsWith('/')) {
      errors.push('BASE_URL must end with a trailing slash ("/"). Current value: ' + config.baseUrl);
      // Attempt to fix it for runtime, but still report error
      // config.baseUrl = config.baseUrl + '/';
    }
  } catch (err) {
    errors.push(`BASE_URL must be a valid URL. Error: ${err.message}`);
  }

  // Validate S3 configuration if STORAGE_TYPE is 's3'
  if (config.storageType === 's3') {
    if (!config.s3Region) errors.push('S3_REGION is required when STORAGE_TYPE is "s3"');
    if (!config.s3BucketName) errors.push('S3_BUCKET_NAME is required when STORAGE_TYPE is "s3"');
    if (!config.s3AccessKeyId) errors.push('S3_ACCESS_KEY_ID is required when STORAGE_TYPE is "s3"');
    if (!config.s3SecretAccessKey) errors.push('S3_SECRET_ACCESS_KEY is required when STORAGE_TYPE is "s3"');

    if (config.s3ForcePathStyle && !config.s3EndpointUrl) {
       logger.warn('S3_FORCE_PATH_STYLE is true, but S3_ENDPOINT_URL is not set. This typically requires a custom endpoint.');
    }
  }

  // Validate local storage dir only if type is local
  if (config.storageType === 'local') {
     if (!config.uploadDir) {
         errors.push('Upload directory could not be determined for local storage.');
     } else {
         // Check existence and writability again (ensureLocalUploadDirExists might have failed)
         try {
             fs.accessSync(config.uploadDir, fs.constants.W_OK);
         } catch (err) {
             errors.push(`Local upload directory "${config.uploadDir}" is not writable or does not exist.`);
         }
     }
  }

  // Check metadata dir existence/writability regardless of storage type, as S3 uses it too
  try {
      const metadataParentDir = path.dirname(path.join(config.uploadDir, '.metadata'));
      if (!fs.existsSync(metadataParentDir)) {
          fs.mkdirSync(metadataParentDir, { recursive: true });
          logger.info(`Created base directory for metadata: ${metadataParentDir}`);
      }
      fs.accessSync(metadataParentDir, fs.constants.W_OK);
  } catch (err) {
      errors.push(`Cannot access or create directory for metadata storage at "${config.uploadDir}". Error: ${err.message}`);
  }


  if (config.nodeEnv === 'production') {
    if (!config.appriseUrl) {
      logger.info('Apprise notifications disabled (APPRISE_URL not set).');
    }
  }

  if (errors.length > 0) {
    logger.error('--- CONFIGURATION ERRORS ---');
    errors.forEach(err => logger.error(`- ${err}`));
    logger.error('-----------------------------');
    throw new Error('Configuration validation failed. Please check environment variables.');
  }

  logger.success('Configuration validated successfully.');
}

// Freeze configuration to prevent modifications after initial load
Object.freeze(config);

module.exports = {
  config,
  validateConfig
};