require('dotenv').config();

const { validatePin } = require('../utils/security');
const logger = require('../utils/logger');
const fs = require('fs'); // Get version from package.json

/**
 * Environment Variables Reference
 *
 * PORT                - Port for the server (default: 3000)
 * NODE_ENV            - Node environment (default: 'development')
 * BASE_URL            - Base URL for the app (default: http://localhost:${PORT})
 * PUBLIC_DOMAIN       - Public domain used for generated download links (default: BASE_URL origin)
 * UPLOAD_DIR          - Directory for uploads (Docker/production)
 * LOCAL_UPLOAD_DIR    - Directory for uploads (local dev, fallback: './local_uploads')
 * MAX_FILE_SIZE       - Max upload size in MB (default: 1024)
 * FILE_RETENTION      - File retention period, format: <number>d or <number>h (default: 30d)
 * AUTO_UPLOAD         - Enable auto-upload (true/false, default: false)
 * SHOW_FILE_LIST      - Enable file listing in frontend (true/false, default: false)
 * DUMBDROP_PIN        - Security PIN for uploads (required for protected endpoints)
 * DUMBDROP_TITLE      - Site title (default: "WickedYoda's DumbDrop")
 * APPRISE_URL         - Apprise notification URL (optional)
 * APPRISE_MESSAGE     - Notification message template (default provided)
 * APPRISE_SIZE_UNIT   - Size unit for notifications (optional)
 * ALLOWED_EXTENSIONS  - Comma-separated list of allowed file extensions (optional)
 */

// Helper for clear configuration logging
const logConfig = (message, level = 'info') => {
  const prefix = level === 'warning' ? '⚠️ WARNING:' : 'ℹ️ INFO:';
  console.log(`${prefix} CONFIGURATION: ${message}`);
};

// Default configurations
const DEFAULT_SITE_TITLE = "WickedYoda's DumbDrop";
const NODE_ENV = process.env.NODE_ENV || 'production';
const PORT = process.env.PORT || 3000;
const BASE_URL = process.env.BASE_URL || `http://localhost:${PORT}`;
const PUBLIC_DOMAIN = process.env.PUBLIC_DOMAIN;
const DEFAULT_CLIENT_MAX_RETRIES = 5; // Default retry count
const DEFAULT_FILE_RETENTION = '30d';

function resolvePublicDomain(rawPublicDomain, fallbackBaseUrl) {
  const candidate = String(rawPublicDomain || '').trim();
  if (candidate) {
    const withProtocol = /^https?:\/\//i.test(candidate) ? candidate : `https://${candidate}`;
    try {
      return new URL(withProtocol).origin;
    } catch {
      logConfig(`PUBLIC_DOMAIN is invalid ("${candidate}"). Falling back to BASE_URL origin.`, 'warning');
    }
  }

  try {
    return new URL(fallbackBaseUrl).origin;
  } catch {
    return `http://localhost:${PORT}`;
  }
}

const resolvedPublicDomain = resolvePublicDomain(PUBLIC_DOMAIN, BASE_URL);
console.log('Loaded ENV:', {
  PORT,
  UPLOAD_DIR: process.env.UPLOAD_DIR,
  LOCAL_UPLOAD_DIR: process.env.LOCAL_UPLOAD_DIR,
  NODE_ENV,
  BASE_URL,
  PUBLIC_DOMAIN: resolvedPublicDomain,
  ALLOWED_ORIGINS: process.env.ALLOWED_ORIGINS || '*',
});
const logAndReturn = (key, value, isDefault = false) => {
  logConfig(`${key}: ${value}${isDefault ? ' (default)' : ''}`);
  return value;
};

function getTermsLink() {
  const rawTermsLink = process.env.TERMS_LINK || process.env.terms_link;
  if (!rawTermsLink) {
    return null;
  }

  try {
    const parsed = new URL(rawTermsLink);
    if (!['http:', 'https:'].includes(parsed.protocol)) {
      logConfig(`Invalid TERMS_LINK protocol: ${parsed.protocol}. Use http or https.`, 'warning');
      return null;
    }
    return rawTermsLink;
  } catch {
    logConfig(`Invalid TERMS_LINK URL: ${rawTermsLink}. Disabling terms link.`, 'warning');
    return null;
  }
}

function parseFileRetentionToMs(rawValue) {
  const parsed = String(rawValue).trim().match(/^(\d+)([dh])$/i);
  if (!parsed) {
    throw new Error('FILE_RETENTION must be in format <number>d or <number>h (examples: 30d, 12h)');
  }

  const amount = parseInt(parsed[1], 10);
  const unit = parsed[2].toLowerCase();
  if (isNaN(amount) || amount <= 0) {
    throw new Error('FILE_RETENTION number must be greater than 0');
  }

  const hourMs = 60 * 60 * 1000;
  return unit === 'd' ? amount * 24 * hourMs : amount * hourMs;
}

/**
 * Determine the upload directory based on environment variables.
 * Priority:
 *   1. UPLOAD_DIR (for Docker/production)
 *   2. LOCAL_UPLOAD_DIR (for local development)
 *   3. './local_uploads' (default fallback)
 * @returns {string} The upload directory path
 */
function determineUploadDirectory() {
  let uploadDir;
  if (process.env.UPLOAD_DIR) {
    uploadDir = process.env.UPLOAD_DIR;
    logConfig(`Upload directory set from UPLOAD_DIR: ${uploadDir}`);
  } else if (process.env.LOCAL_UPLOAD_DIR) {
    uploadDir = process.env.LOCAL_UPLOAD_DIR;
    logConfig(`Upload directory using LOCAL_UPLOAD_DIR fallback: ${uploadDir}`, 'warning');
  } else {
    uploadDir = './local_uploads';
    logConfig(`Upload directory using default fallback: ${uploadDir}`, 'warning');
  }
  logConfig(`Final upload directory path: ${require('path').resolve(uploadDir)}`);
  return uploadDir;
}

/**
 * Utility to detect if running in local development mode
 * Returns true if NODE_ENV is not 'production' and UPLOAD_DIR is not set (i.e., not Docker)
 */
function isLocalDevelopment() {
  return process.env.NODE_ENV !== 'production';
}

/**
 * Ensure the upload directory exists (for local development only)
 * Creates the directory if it does not exist
 */
function ensureLocalUploadDirExists(uploadDir) {
  if (!isLocalDevelopment()) return;
  try {
    if (!fs.existsSync(uploadDir)) {
      fs.mkdirSync(uploadDir, { recursive: true });
      logConfig(`Created local upload directory: ${uploadDir}`);
    } else {
      logConfig(`Local upload directory exists: ${uploadDir}`);
    }
  } catch (err) {
    logConfig(`Failed to create local upload directory: ${uploadDir}. Error: ${err.message}`, 'warning');
  }
}

// Determine and ensure upload directory (for local dev)
const resolvedUploadDir = determineUploadDirectory();
ensureLocalUploadDirExists(resolvedUploadDir);

/**
 * Application configuration
 * Loads and validates environment variables
 */
const config = {
  // =====================
  // =====================
  // Server settings
  // =====================
  /**
   * Port for the server (default: 3000)
   * Set via PORT in .env
   */
  port: PORT,
  /**
   * Node environment (default: 'production')
   * Set via NODE_ENV in .env
   */
  nodeEnv: NODE_ENV,
  /**
   * Base URL for the app (default: http://localhost:${PORT})
   * Set via BASE_URL in .env
   */
  baseUrl: BASE_URL,
  /**
   * Public domain used for generated download links (default: BASE_URL origin)
   * Set via PUBLIC_DOMAIN in .env
   */
  publicDomain: resolvedPublicDomain,
  
  // =====================
  // =====================
  // Upload settings
  // =====================
  /**
   * Directory for uploads
   * Priority: UPLOAD_DIR (Docker/production) > LOCAL_UPLOAD_DIR (local dev) > './local_uploads' (fallback)
   */
  uploadDir: resolvedUploadDir,
  /**
   * Max upload size in bytes (default: 1024MB)
   * Set via MAX_FILE_SIZE in .env (in MB)
   */
  maxFileSize: (() => {
    const sizeInMB = parseInt(process.env.MAX_FILE_SIZE || '1024', 10);
    if (isNaN(sizeInMB) || sizeInMB <= 0) {
      throw new Error('MAX_FILE_SIZE must be a positive number');
    }
    return sizeInMB * 1024 * 1024; // Convert MB to bytes
  })(),
  /**
   * Enable auto-upload (true/false, default: false)
   * Set via AUTO_UPLOAD in .env
   */
  autoUpload: process.env.AUTO_UPLOAD === 'true',
  /**
   * Enable file listing in frontend (true/false, default: false)
   * Set via SHOW_FILE_LIST in .env
   */
  showFileList: process.env.SHOW_FILE_LIST === 'true',
  /**
   * File retention period in milliseconds.
   * Set via FILE_RETENTION in .env using <number>d or <number>h (default: 30d)
   */
  fileRetentionMs: (() => {
    const envValue = process.env.FILE_RETENTION;
    const effectiveValue = envValue === undefined ? DEFAULT_FILE_RETENTION : envValue;

    try {
      const ms = parseFileRetentionToMs(effectiveValue);
      logAndReturn('FILE_RETENTION', effectiveValue, envValue === undefined);
      return ms;
    } catch (err) {
      if (envValue !== undefined) {
        throw err;
      }

      logConfig(`Invalid default FILE_RETENTION value "${effectiveValue}". Falling back to ${DEFAULT_FILE_RETENTION}.`, 'warning');
      return parseFileRetentionToMs(DEFAULT_FILE_RETENTION);
    }
  })(),
  
  // =====================
  // =====================
  // Security
  // =====================
  /**
   * Security PIN for uploads (required for protected endpoints)
   * Set via DUMBDROP_PIN in .env
   */
  pin: validatePin(process.env.DUMBDROP_PIN),
  /**
   * Trust proxy for X-Forwarded-For header (default: false for security)
   * Only enable if behind a trusted reverse proxy
   * Set via TRUST_PROXY in .env
   */
  trustProxy: process.env.TRUST_PROXY === 'true',
  /**
   * Comma-separated list of trusted proxy IPs (optional)
   * Restricts which proxies can set X-Forwarded-For header
   * Set via TRUSTED_PROXY_IPS in .env
   */
  trustedProxyIps: process.env.TRUSTED_PROXY_IPS ? 
    process.env.TRUSTED_PROXY_IPS.split(',').map(ip => ip.trim()) : 
    null,
  
  // =====================
  // =====================
  // UI settings
  // =====================
  /**
  * Site title (default: "WickedYoda's DumbDrop")
   * Set via DUMBDROP_TITLE in .env
   */
  siteTitle: process.env.DUMBDROP_TITLE || DEFAULT_SITE_TITLE,
  /**
   * Terms and Conditions URL (optional)
   * Set via TERMS_LINK in .env
   */
  termsLink: getTermsLink(),
  
  // =====================
  // =====================
  // Notification settings
  // =====================
  /**
   * Apprise notification URL (optional)
   * Set via APPRISE_URL in .env
   */
  appriseUrl: process.env.APPRISE_URL,
  /**
   * Notification message template (default provided)
   * Set via APPRISE_MESSAGE in .env
   */
  appriseMessage: process.env.APPRISE_MESSAGE || 'New file uploaded - {filename} ({size}), Storage used {storage}',
  /**
   * Size unit for notifications (optional)
   * Set via APPRISE_SIZE_UNIT in .env
   */
  appriseSizeUnit: process.env.APPRISE_SIZE_UNIT,
  
  // =====================
  // =====================
  // File extensions
  // =====================
  /**
   * Allowed file extensions (comma-separated, optional)
   * Set via ALLOWED_EXTENSIONS in .env
   */
  allowedExtensions: process.env.ALLOWED_EXTENSIONS ? 
    process.env.ALLOWED_EXTENSIONS.split(',').map(ext => ext.trim().toLowerCase()) : 
    null,

  /**
   * Max number of retries for client-side chunk uploads (default: 5)
   * Set via CLIENT_MAX_RETRIES in .env
   */
  clientMaxRetries: (() => {
    const envValue = process.env.CLIENT_MAX_RETRIES;
    const defaultValue = DEFAULT_CLIENT_MAX_RETRIES;
    if (envValue === undefined) {
      return logAndReturn('CLIENT_MAX_RETRIES', defaultValue, true);
    }
    const retries = parseInt(envValue, 10);
    if (isNaN(retries) || retries < 0) {
      logConfig(
        `Invalid CLIENT_MAX_RETRIES value: "${envValue}". Using default: ${defaultValue}`,
        'warning',
      );
      return logAndReturn('CLIENT_MAX_RETRIES', defaultValue, true);
    }
    return logAndReturn('CLIENT_MAX_RETRIES', retries);
  })(),

  uploadPin: logAndReturn('UPLOAD_PIN', process.env.UPLOAD_PIN || null),
};

console.log(`Upload directory configured as: ${config.uploadDir}`);

// Validate required settings
function validateConfig() {
  const errors = [];
  
  if (config.maxFileSize <= 0) {
    errors.push('MAX_FILE_SIZE must be greater than 0');
  }

  // Validate BASE_URL format
  try {
    // Ensure BASE_URL ends with a slash
    if (!config.baseUrl.endsWith('/')) {
      logger.warn('BASE_URL did not end with a trailing slash. Automatically appending "/".');
      config.baseUrl = config.baseUrl + '/';
    }
  } catch (err) {
    const errorMsg = `BASE_URL must be a valid URL: ${err.message || err}`;
    logger.error(errorMsg);
    errors.push(errorMsg);
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