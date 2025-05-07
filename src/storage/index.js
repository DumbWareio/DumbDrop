/**
 * Storage Adapter Factory
 * Reads the application configuration and exports the appropriate storage adapter
 * (either local or S3) based on the STORAGE_TYPE environment variable.
 * This provides a single point of import for storage operations throughout the app.
 */

const { config } = require('../config'); // Assuming config is initialized before this runs
const logger = require('../utils/logger');

let storageAdapter;

logger.info(`Initializing storage adapter based on STORAGE_TYPE: "${config.storageType}"`);

if (config.isDemoMode) {
    logger.warn('[Storage] DEMO MODE ENABLED. Using mock storage adapter.');
    // In demo mode, we might want a completely separate mock adapter
    // or potentially just disable storage operations. For now, let's use local
    // but be aware demo mode might need its own logic if strict separation is needed.
    // Or, create a dedicated demoAdapter.js
    // For simplicity now, let's log and maybe default to local (which is non-persistent in demo anyway).
    // A dedicated demoAdapter would be cleaner:
    // storageAdapter = require('./demoAdapter'); // Requires creating demoAdapter.js
    // Fallback for now:
    storageAdapter = require('./localAdapter');
    logger.info('[Storage] Using Local Adapter for Demo Mode (operations will be mocked or non-persistent).');

} else if (config.storageType === 's3') {
    logger.info('[Storage] Using S3 Storage Adapter.');
    try {
        storageAdapter = require('./s3Adapter');
    } catch (error) {
         logger.error(`[Storage] Failed to load S3 Adapter: ${error.message}`);
         logger.error('[Storage] Check S3 configuration environment variables and AWS SDK installation.');
         process.exit(1); // Exit if the configured adapter fails to load
    }
} else {
    // Default to local storage if type is 'local' or invalid/not specified
    if (config.storageType !== 'local') {
        logger.warn(`[Storage] Invalid or unspecified STORAGE_TYPE "${config.storageType}", defaulting to "local".`);
    }
    logger.info('[Storage] Using Local Storage Adapter.');
    try {
        storageAdapter = require('./localAdapter');
    } catch (error) {
         logger.error(`[Storage] Failed to load Local Adapter: ${error.message}`);
         process.exit(1); // Exit if the default adapter fails
    }
}

// Ensure the selected adapter is valid before exporting
if (!storageAdapter || typeof storageAdapter.initUpload !== 'function') {
    logger.error('[Storage] Failed to initialize a valid storage adapter. Exiting.');
    process.exit(1);
}

logger.success(`[Storage] Storage adapter "${config.storageType}" initialized successfully.`);

module.exports = { storageAdapter };