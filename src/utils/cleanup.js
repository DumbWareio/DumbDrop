const fs = require('fs');
const path = require('path');
const logger = require('./logger');
const { config } = require('../config');

/**
 * Clean up incomplete uploads and temporary files
 * @param {Map} uploads - Map of active uploads
 * @param {Map} uploadToBatch - Map of upload IDs to batch IDs
 * @param {Map} batchActivity - Map of batch IDs to last activity timestamp
 */
async function cleanupIncompleteUploads(uploads, uploadToBatch, batchActivity) {
  try {
    // Get current time
    const now = Date.now();
    const inactivityThreshold = config.uploadTimeout || 30 * 60 * 1000; // 30 minutes default

    // Check each upload
    for (const [uploadId, upload] of uploads.entries()) {
      try {
        const batchId = uploadToBatch.get(uploadId);
        const lastActivity = batchActivity.get(batchId);

        // If upload is inactive for too long
        if (now - lastActivity > inactivityThreshold) {
          // Close write stream
          if (upload.writeStream) {
            await new Promise((resolve) => {
              upload.writeStream.end(() => resolve());
            });
          }

          // Delete incomplete file
          try {
            await fs.promises.unlink(upload.filePath);
            logger.info(`Cleaned up incomplete upload: ${upload.safeFilename}`);
          } catch (err) {
            if (err.code !== 'ENOENT') {
              logger.error(`Failed to delete incomplete upload ${upload.safeFilename}: ${err.message}`);
            }
          }

          // Remove from maps
          uploads.delete(uploadId);
          uploadToBatch.delete(uploadId);
        }
      } catch (err) {
        logger.error(`Error cleaning up upload ${uploadId}: ${err.message}`);
      }
    }

    // Clean up empty folders
    await cleanupEmptyFolders(config.uploadDir);

  } catch (err) {
    logger.error(`Cleanup error: ${err.message}`);
  }
}

/**
 * Recursively remove empty folders
 * @param {string} dir - Directory to clean
 */
async function cleanupEmptyFolders(dir) {
  try {
    const files = await fs.promises.readdir(dir);
    
    for (const file of files) {
      const fullPath = path.join(dir, file);
      const stats = await fs.promises.stat(fullPath);
      
      if (stats.isDirectory()) {
        await cleanupEmptyFolders(fullPath);
        
        // Check if directory is empty after cleaning subdirectories
        const remaining = await fs.promises.readdir(fullPath);
        if (remaining.length === 0) {
          await fs.promises.rmdir(fullPath);
          logger.info(`Removed empty directory: ${fullPath}`);
        }
      }
    }
  } catch (err) {
    logger.error(`Failed to clean empty folders: ${err.message}`);
  }
}

module.exports = {
  cleanupIncompleteUploads,
  cleanupEmptyFolders
}; 