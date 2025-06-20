// File: src/config/index.js
require('dotenv').config();
const { validatePin } = require('../utils/security');
const logger = require('../utils/logger');
const fs = require('fs');
const path = require('path');
// const { version } = require('../../package.json'); // version not currently used, can be removed or kept

// --- Environment Variables Reference ---
/* (Comments listing all ENV vars - keep as is) */

// --- Helper for clear configuration logging ---
const logConfig = (message, level = 'info') => {
  const prefix = level === 'warning' ? '⚠️ WARNING:' : 'ℹ️ INFO:';
  console.log(`${prefix} CONFIGURATION: ${message}`);
};

// --- Default configurations ---
const DEFAULT_PORT = 3000;
const DEFAULT_SITE_TITLE = 'DumbDrop';
const DEFAULT_BASE_URL_PREFIX = 'http://localhost'; // Prefix, port added later
const DEFAULT_CLIENT_MAX_RETRIES = 5;
const DEFAULT_STORAGE_TYPE = 'local';

const logAndReturn = (key, value, isDefault = false, sensitive = false) => {
  const displayValue = sensitive ? '********' : value;
  logConfig(`${key}: ${displayValue}${isDefault ? ' (default)' : ''}`);
  return value;
};

function isLocalDevelopment() {
  return process.env.NODE_ENV !== 'production' && !process.env.UPLOAD_DIR;
}

function determineLocalUploadDirectory() {
  if (process.env.STORAGE_TYPE && process.env.STORAGE_TYPE.toLowerCase() !== 'local') {
    return null; // Not using local storage
  }
  let uploadDir;
  if (process.env.UPLOAD_DIR) {
    uploadDir = process.env.UPLOAD_DIR;
    // logger.info(`[Local Storage] Upload directory set from UPLOAD_DIR: ${uploadDir}`); // Logger might not be fully init here
  } else if (process.env.LOCAL_UPLOAD_DIR) {
    uploadDir = process.env.LOCAL_UPLOAD_DIR;
    // logger.warn(`[Local Storage] Upload directory using LOCAL_UPLOAD_DIR fallback: ${uploadDir}`);
  } else {
    uploadDir = './local_uploads';
    // logger.warn(`[Local Storage] Upload directory using default fallback: ${uploadDir}`);
  }
  // logger.info(`[Local Storage] Final upload directory path: ${path.resolve(uploadDir)}`);
  return path.resolve(uploadDir); // Always resolve to absolute
}

function ensureLocalUploadDirExists(dirPath) {
  if (!dirPath || !isLocalDevelopment()) {
    return;
  }
  try {
    if (!fs.existsSync(dirPath)) {
      fs.mkdirSync(dirPath, { recursive: true });
      console.log(`[INFO] CONFIGURATION: [Local Storage] Created local upload directory: ${dirPath}`);
    } else {
      console.log(`[INFO] CONFIGURATION: [Local Storage] Local upload directory exists: ${dirPath}`);
    }
    fs.accessSync(dirPath, fs.constants.W_OK);
    console.log(`[SUCCESS] CONFIGURATION: [Local Storage] Local upload directory is writable: ${dirPath}`);
  } catch (err) {
    console.error(`[ERROR] CONFIGURATION: [Local Storage] Failed to create or access local upload directory: ${dirPath}. Error: ${err.message}`);
    throw new Error(`Upload directory "${dirPath}" is not accessible or writable.`);
  }
}

const storageTypeInput = process.env.STORAGE_TYPE || DEFAULT_STORAGE_TYPE;
const storageType = ['local', 's3'].includes(storageTypeInput.toLowerCase())
  ? storageTypeInput.toLowerCase()
  : DEFAULT_STORAGE_TYPE;

if (storageTypeInput.toLowerCase() !== storageType) {
  console.warn(`[WARN] CONFIGURATION: Invalid STORAGE_TYPE "${storageTypeInput}", using default: "${storageType}"`);
}

const resolvedLocalUploadDir = determineLocalUploadDirectory();
if (storageType === 'local' && resolvedLocalUploadDir) { // Only ensure if actually using local storage
  ensureLocalUploadDirExists(resolvedLocalUploadDir);
}

const parseFooterLinks = (linksString) => {
  if (!linksString) return [];
  return linksString.split(',')
    .map(linkPair => {
      const parts = linkPair.split('@').map(part => part.trim());
      if (parts.length === 2 && parts[0] && parts[1] && (parts[1].startsWith('http://') || parts[1].startsWith('https://'))) {
        return { text: parts[0], url: parts[1] };
      }
      // logger.warn(`Invalid format or URL in FOOTER_LINKS: "${linkPair}".`); // Logger might not be fully init
      return null;
    })
    .filter(link => link !== null);
};

const port = parseInt(process.env.PORT || DEFAULT_PORT, 10);
const baseUrl = process.env.BASE_URL || `${DEFAULT_BASE_URL_PREFIX}:${port}/`;

const config = {
  port,
  nodeEnv: process.env.NODE_ENV || 'development',
  baseUrl,
  isDemoMode: process.env.DEMO_MODE === 'true',
  storageType,
  uploadDir: storageType === 'local' ? resolvedLocalUploadDir : path.resolve(process.env.UPLOAD_DIR || process.env.LOCAL_UPLOAD_DIR || './uploads'), // For S3, metadata dir. Fallback required.
  s3Region: process.env.S3_REGION || null,
  s3BucketName: process.env.S3_BUCKET_NAME || null,
  s3AccessKeyId: process.env.S3_ACCESS_KEY_ID || null,
  s3SecretAccessKey: process.env.S3_SECRET_ACCESS_KEY || null,
  s3EndpointUrl: process.env.S3_ENDPOINT_URL || null,
  s3ForcePathStyle: process.env.S3_FORCE_PATH_STYLE === 'true',
  maxFileSize: (() => {
    const sizeInMB = parseInt(process.env.MAX_FILE_SIZE || '1024', 10);
    return (isNaN(sizeInMB) || sizeInMB <= 0 ? 1024 : sizeInMB) * 1024 * 1024;
  })(),
  autoUpload: process.env.AUTO_UPLOAD === 'true',
  allowedExtensions: process.env.ALLOWED_EXTENSIONS ?
    process.env.ALLOWED_EXTENSIONS.split(',').map(ext => ext.trim().toLowerCase().replace(/^\./, '.')).filter(Boolean) :
    null,

  /**
   * Allowed CORS origins (comma-separated, optional)
   * Set via ALLOWED_ORIGINS in .env
   * Defaults to localhost variants and BASE_URL origin if not specified
   */
  allowedOrigins: (() => {
    const defaultOrigins = [
      'http://localhost:3000',
      'http://127.0.0.1:3000',
      'http://localhost:5050',
      'http://127.0.0.1:5050'
    ];

    // Extract origin from BASE_URL and add to defaults
    try {
      const baseUrlOrigin = new URL(process.env.BASE_URL || DEFAULT_BASE_URL).origin;
      if (!defaultOrigins.includes(baseUrlOrigin)) {
        defaultOrigins.push(baseUrlOrigin);
      }
    } catch (err) {
      logConfig(`Failed to parse BASE_URL for CORS origin: ${err.message}`, 'warning');
    }

    return process.env.ALLOWED_ORIGINS ? 
      process.env.ALLOWED_ORIGINS.split(',').map(origin => origin.trim()).filter(Boolean) : 
      defaultOrigins;
  })(),

  allowedIframeOrigins: process.env.ALLOWED_IFRAME_ORIGINS
    ? process.env.ALLOWED_IFRAME_ORIGINS.split(',').map(origin => origin.trim()).filter(Boolean)
    : null,

  /**
   * Max number of retries for client-side chunk uploads (default: 5)
   * Set via CLIENT_MAX_RETRIES in .env
   */
  clientMaxRetries: (() => {
    const retries = parseInt(process.env.CLIENT_MAX_RETRIES || DEFAULT_CLIENT_MAX_RETRIES, 10);
    return (isNaN(retries) || retries < 0) ? DEFAULT_CLIENT_MAX_RETRIES : retries;
  })(),
  pin: validatePin(process.env.DUMBDROP_PIN), // validatePin uses logger, ensure logger is available
  siteTitle: process.env.DUMBDROP_TITLE || DEFAULT_SITE_TITLE,
  footerLinks: parseFooterLinks(process.env.FOOTER_LINKS),
  appriseUrl: process.env.APPRISE_URL || null,
  appriseMessage: process.env.APPRISE_MESSAGE || 'New file uploaded - {filename} ({size}), Storage used {storage}',
  appriseSizeUnit: process.env.APPRISE_SIZE_UNIT || 'Auto',
};

// --- Log Configuration (after logger is confirmed available) ---
// Moved logging to after config object is built, so logger is definitely available
logger.info(`--- Configuration Start ---`);
logAndReturn('NODE_ENV', config.nodeEnv);
logAndReturn('PORT', config.port);
logAndReturn('BASE_URL', config.baseUrl);
logAndReturn('DEMO_MODE', config.isDemoMode);
logAndReturn('STORAGE_TYPE', config.storageType);
if (config.storageType === 'local') {
  logAndReturn('Upload Directory (Local Storage)', config.uploadDir);
} else {
  logAndReturn('Metadata Directory (S3 Mode)', config.uploadDir); // Clarify role for S3
  logAndReturn('S3_REGION', config.s3Region);
  logAndReturn('S3_BUCKET_NAME', config.s3BucketName);
  logAndReturn('S3_ACCESS_KEY_ID', config.s3AccessKeyId, false, true);
  logAndReturn('S3_SECRET_ACCESS_KEY', config.s3SecretAccessKey, false, true);
  if (config.s3EndpointUrl) logAndReturn('S3_ENDPOINT_URL', config.s3EndpointUrl);
  logAndReturn('S3_FORCE_PATH_STYLE', config.s3ForcePathStyle);
}
logger.info(`Max File Size: ${config.maxFileSize / (1024 * 1024)}MB`);
logger.info(`Auto Upload: ${config.autoUpload}`);
if (config.allowedExtensions) logger.info(`Allowed Extensions: ${config.allowedExtensions.join(', ')}`);
if (config.pin) logAndReturn('DUMBDROP_PIN', config.pin, false, true);
if (config.allowedIframeOrigins) logger.info(`Allowed Iframe Origins: ${config.allowedIframeOrigins.join(', ')}`);
if (config.appriseUrl) logAndReturn('APPRISE_URL', config.appriseUrl);
logger.info(`Client Max Retries: ${config.clientMaxRetries}`);
logger.info(`--- Configuration End ---`);


function validateConfig() {
  const errors = [];
  if (config.port <= 0 || config.port > 65535) errors.push('PORT must be a valid number between 1 and 65535');
  if (config.maxFileSize <= 0) errors.push('MAX_FILE_SIZE must be greater than 0');
  try {
    new URL(config.baseUrl);
    if (!config.baseUrl.endsWith('/')) errors.push('BASE_URL must end with a trailing slash ("/"). Current: ' + config.baseUrl);
  } catch (err) { errors.push(`BASE_URL must be a valid URL. Error: ${err.message}`); }

  if (config.storageType === 's3') {
    if (!config.s3Region) errors.push('S3_REGION is required for S3 storage');
    if (!config.s3BucketName) errors.push('S3_BUCKET_NAME is required for S3 storage');
    if (!config.s3AccessKeyId) errors.push('S3_ACCESS_KEY_ID is required for S3 storage');
    if (!config.s3SecretAccessKey) errors.push('S3_SECRET_ACCESS_KEY is required for S3 storage');
    if (config.s3ForcePathStyle && !config.s3EndpointUrl) {
       logger.warn('[Config Validation] S3_FORCE_PATH_STYLE is true, but S3_ENDPOINT_URL is not set. This may not work as expected with default AWS endpoints.');
    }
  } else if (config.storageType === 'local') {
     if (!config.uploadDir) errors.push('Upload directory (UPLOAD_DIR or LOCAL_UPLOAD_DIR) is required for local storage.');
     else {
         try { fs.accessSync(config.uploadDir, fs.constants.W_OK); }
         catch (err) { errors.push(`Local upload directory "${config.uploadDir}" is not writable or does not exist.`); }
     }
  }

  // Metadata directory check (for both local file metadata and S3 upload state metadata)
  if (!config.uploadDir) { // This condition might be redundant if local storage dir is already checked
      errors.push('A base directory (UPLOAD_DIR or LOCAL_UPLOAD_DIR) is required for metadata storage.');
  } else {
      try {
          const metadataBase = path.resolve(config.uploadDir); // Base for .metadata
          if (!fs.existsSync(metadataBase)) {
              fs.mkdirSync(metadataBase, { recursive: true });
              logger.info(`[Config Validation] Created base directory for metadata: ${metadataBase}`);
          }
          fs.accessSync(metadataBase, fs.constants.W_OK); // Check writability of the parent of .metadata
      } catch (err) {
          errors.push(`Cannot access or create base directory for metadata at "${config.uploadDir}". Error: ${err.message}`);
      }
  }


  if (errors.length > 0) {
    logger.error('--- CONFIGURATION ERRORS ---');
    errors.forEach(err => logger.error(`- ${err}`));
    logger.error('-----------------------------');
    throw new Error('Configuration validation failed. Please check environment variables and correct the issues.');
  }
  logger.success('[Config Validation] Configuration validated successfully.');
}

Object.freeze(config); // Freeze after logging and validation

module.exports = { config, validateConfig };