const fs = require('fs');
const path = require('path');
const logger = require('./logger');
const { config } = require('../config');

/**
 * Stores cleanup tasks that need to be run during shutdown
 * @type {Set<Function>}
 */
const cleanupTasks = new Set();

/**
 * Register a cleanup task to be executed during shutdown
 * @param {Function} task - Async function to be executed during cleanup
 */
function registerCleanupTask(task) {
  cleanupTasks.add(task);
}

/**
 * Remove a cleanup task
 * @param {Function} task - Task to remove
 */
function removeCleanupTask(task) {
  cleanupTasks.delete(task);
}

/**
 * Execute all registered cleanup tasks
 * @param {number} [timeout=1000] - Maximum time in ms to wait for cleanup
 * @returns {Promise<void>}
 */
async function executeCleanup(timeout = 1000) {
  const taskCount = cleanupTasks.size;
  if (taskCount === 0) {
    logger.info('No cleanup tasks to execute');
    return;
  }
  
  logger.info(`Executing ${taskCount} cleanup tasks...`);
  
  try {
    // Run all cleanup tasks in parallel with timeout
    await Promise.race([
      Promise.all(
        Array.from(cleanupTasks).map(async (task) => {
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
    cleanupTasks.clear();
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
  registerCleanupTask,
  removeCleanupTask,
  executeCleanup,
  cleanupIncompleteUploads,
  cleanupEmptyFolders
}; 