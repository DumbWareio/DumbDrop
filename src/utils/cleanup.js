/**
 * Cleanup utilities for managing application resources.
 * Handles incomplete uploads, empty folders, and shutdown tasks.
 * Provides cleanup task registration and execution system.
 */

const fs = require('fs').promises;
const path = require('path');
const logger = require('./logger');
const { config } = require('../config');

const METADATA_DIR = path.join(config.uploadDir, '.metadata');
const UPLOAD_TIMEOUT = config.uploadTimeout || 30 * 60 * 1000; // Use a config or default (e.g., 30 mins)

let cleanupTasks = [];

/**
 * Register a cleanup task to be executed during shutdown
 * @param {Function} task - Async function to be executed during cleanup
 */
function registerCleanupTask(task) {
  cleanupTasks.push(task);
}

/**
 * Remove a cleanup task
 * @param {Function} task - Task to remove
 */
function removeCleanupTask(task) {
  cleanupTasks = cleanupTasks.filter((t) => t !== task);
}

/**
 * Execute all registered cleanup tasks
 * @param {number} [timeout=1000] - Maximum time in ms to wait for cleanup
 * @returns {Promise<void>}
 */
async function executeCleanup(timeout = 1000) {
  const taskCount = cleanupTasks.length;
  if (taskCount === 0) {
    logger.info('No cleanup tasks to execute');
    return;
  }
  
  logger.info(`Executing ${taskCount} cleanup tasks...`);
  
  try {
    // Run all cleanup tasks in parallel with timeout
    await Promise.race([
      Promise.all(
        cleanupTasks.map(async (task) => {
          try {
            await Promise.race([
              task(),
              new Promise((_, reject) => 
                setTimeout(() => reject(new Error('Task timeout')), timeout / 2)
              )
            ]);
          } catch (error) {
            if (error.message === 'Task timeout') {
              logger.warn('Cleanup task timed out');
            } else {
              logger.error(`Cleanup task failed: ${error.message}`);
            }
          }
        })
      ),
      new Promise((_, reject) => 
        setTimeout(() => reject(new Error('Global timeout')), timeout)
      )
    ]);
    
    logger.info('Cleanup completed successfully');
  } catch (error) {
    if (error.message === 'Global timeout') {
      logger.warn(`Cleanup timed out after ${timeout}ms`);
    } else {
      logger.error(`Cleanup failed: ${error.message}`);
    }
  } finally {
    // Clear all tasks regardless of success/failure
    cleanupTasks = [];
  }
}

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
            await fs.unlink(upload.filePath);
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
 * Clean up stale/incomplete uploads based on metadata files.
 */
async function cleanupIncompleteMetadataUploads() {
  logger.info('Running cleanup for stale metadata/partial uploads...');
  let cleanedCount = 0;
  let checkedCount = 0;

  try {
    // Ensure metadata directory exists before trying to read it
    try {
      await fs.access(METADATA_DIR);
    } catch (accessErr) {
      if (accessErr.code === 'ENOENT') {
        logger.info('Metadata directory does not exist, skipping metadata cleanup.');
        return;
      }
      throw accessErr; // Rethrow other access errors
    }

    const files = await fs.readdir(METADATA_DIR);
    const now = Date.now();

    for (const file of files) {
      if (file.endsWith('.meta')) {
        checkedCount++;
        const metaFilePath = path.join(METADATA_DIR, file);
        let metadata;

        try {
          const data = await fs.readFile(metaFilePath, 'utf8');
          metadata = JSON.parse(data);

          // Check inactivity based on lastActivity timestamp in metadata
          if (now - (metadata.lastActivity || metadata.createdAt || 0) > UPLOAD_TIMEOUT) {
            logger.warn(`Found stale upload metadata: ${file}. Last activity: ${new Date(metadata.lastActivity || metadata.createdAt)}`);

            // Attempt to delete partial file
            if (metadata.partialFilePath) {
              try {
                await fs.unlink(metadata.partialFilePath);
                logger.info(`Deleted stale partial file: ${metadata.partialFilePath}`);
              } catch (unlinkPartialErr) {
                if (unlinkPartialErr.code !== 'ENOENT') { // Ignore if already gone
                  logger.error(`Failed to delete stale partial file ${metadata.partialFilePath}: ${unlinkPartialErr.message}`);
                }
              }
            }

            // Attempt to delete metadata file
            try {
              await fs.unlink(metaFilePath);
              logger.info(`Deleted stale metadata file: ${file}`);
              cleanedCount++;
            } catch (unlinkMetaErr) {
              logger.error(`Failed to delete stale metadata file ${metaFilePath}: ${unlinkMetaErr.message}`);
            }

          }
        } catch (readErr) {
          logger.error(`Error reading or parsing metadata file ${metaFilePath} during cleanup: ${readErr.message}. Skipping.`);
          // Optionally attempt to delete the corrupt meta file?
          // await fs.unlink(metaFilePath).catch(()=>{});
        }
      } else if (file.endsWith('.tmp')) {
        // Clean up potential leftover temp metadata files
        const tempMetaPath = path.join(METADATA_DIR, file);
        try {
          const stats = await fs.stat(tempMetaPath);
          if (now - stats.mtime.getTime() > UPLOAD_TIMEOUT) { // If temp file is also old
            logger.warn(`Deleting stale temporary metadata file: ${file}`);
            await fs.unlink(tempMetaPath);
          }
        } catch (statErr) {
          if (statErr.code !== 'ENOENT') { // Ignore if already gone
            logger.error(`Error checking temporary metadata file ${tempMetaPath}: ${statErr.message}`);
          }
        }
      }
    }

    if (checkedCount > 0 || cleanedCount > 0) {
      logger.info(`Metadata cleanup finished. Checked: ${checkedCount}, Cleaned stale: ${cleanedCount}.`);
    }

  } catch (err) {
    // Handle errors reading the METADATA_DIR itself
    if (err.code === 'ENOENT') {
      logger.info('Metadata directory not found during cleanup scan.'); // Should have been created on init
    } else {
      logger.error(`Error during metadata cleanup scan: ${err.message}`);
    }
  }

  // Also run empty folder cleanup
  await cleanupEmptyFolders(config.uploadDir);
}

// Schedule the new cleanup function
const METADATA_CLEANUP_INTERVAL = 15 * 60 * 1000; // e.g., every 15 minutes
let metadataCleanupTimer;

if (!process.env.DISABLE_BATCH_CLEANUP) {
  metadataCleanupTimer = setInterval(cleanupIncompleteMetadataUploads, METADATA_CLEANUP_INTERVAL);
  metadataCleanupTimer.unref(); // Allow process to exit if this is the only timer
  
  process.on('SIGTERM', () => clearInterval(metadataCleanupTimer));
  process.on('SIGINT', () => clearInterval(metadataCleanupTimer));
}

/**
 * Recursively remove empty folders
 * @param {string} dir - Directory to clean
 */
async function cleanupEmptyFolders(dir) {
  try {
    // Avoid trying to clean the special .metadata directory itself
    if (path.basename(dir) === '.metadata') {
      logger.debug(`Skipping cleanup of metadata directory: ${dir}`);
      return;
    }

    const files = await fs.readdir(dir);
    for (const file of files) {
      const fullPath = path.join(dir, file);

      // Skip the metadata directory during traversal
      if (path.basename(fullPath) === '.metadata') {
        logger.debug(`Skipping traversal into metadata directory: ${fullPath}`);
        continue;
      }

      let stats;
      try {
        stats = await fs.stat(fullPath);
      } catch (statErr) {
        if (statErr.code === 'ENOENT') continue; // File might have been deleted concurrently
        throw statErr;
      }

      if (stats.isDirectory()) {
        await cleanupEmptyFolders(fullPath);
        // Check if directory is empty after cleaning subdirectories
        let remaining = [];
        try {
          remaining = await fs.readdir(fullPath);
        } catch (readErr) {
          if (readErr.code === 'ENOENT') continue; // Directory was deleted
          throw readErr;
        }

        if (remaining.length === 0) {
          // Make sure we don't delete the main upload dir
          if (fullPath !== path.resolve(config.uploadDir)) {
            try {
              await fs.rmdir(fullPath);
              logger.info(`Removed empty directory: ${fullPath}`);
            } catch (rmErr) {
              if (rmErr.code !== 'ENOENT') { // Ignore if already deleted
                logger.error(`Failed to remove supposedly empty directory ${fullPath}: ${rmErr.message}`);
              }
            }
          }
        }
      }
    }
  } catch (err) {
    if (err.code !== 'ENOENT') { // Ignore if dir was already deleted
      logger.error(`Failed to clean empty folders in ${dir}: ${err.message}`);
    }
  }
}

module.exports = {
  registerCleanupTask,
  removeCleanupTask,
  executeCleanup,
  cleanupIncompleteUploads,
  cleanupIncompleteMetadataUploads,
  cleanupEmptyFolders
}; 