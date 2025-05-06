/**
 * Cleanup utilities for managing application resources.
 * Handles registration and execution of cleanup tasks, including delegation
 * of storage-specific cleanup (like stale uploads) to the storage adapter.
 * Also includes generic cleanup like removing empty folders (for local storage).
 */

const fs = require('fs').promises;
const path = require('path');
const logger = require('./logger');
const { config } = require('../config');
const { storageAdapter } = require('../storage'); // Import the selected adapter

// --- Generic Cleanup Task Management ---
let cleanupTasks = [];

/**
 * Register a generic cleanup task to be executed during shutdown.
 * @param {Function} task - Async function to be executed during cleanup.
 */
function registerCleanupTask(task) {
  cleanupTasks.push(task);
}

/**
 * Remove a generic cleanup task.
 * @param {Function} task - Task to remove.
 */
function removeCleanupTask(task) {
  cleanupTasks = cleanupTasks.filter((t) => t !== task);
}

/**
 * Execute all registered generic cleanup tasks.
 * @param {number} [timeout=1000] - Maximum time in ms to wait for cleanup.
 * @returns {Promise<void>}
 */
async function executeCleanup(timeout = 1000) {
  const taskCount = cleanupTasks.length;
  if (taskCount === 0) {
    logger.info('[Cleanup] No generic cleanup tasks to execute');
    return;
  }

  logger.info(`[Cleanup] Executing ${taskCount} generic cleanup tasks...`);

  try {
    // Run all tasks concurrently with individual and global timeouts
    await Promise.race([
      Promise.all(
        cleanupTasks.map(async (task, index) => {
          try {
            await Promise.race([
              task(),
              new Promise((_, reject) =>
                setTimeout(() => reject(new Error(`Task ${index + 1} timeout`)), timeout / 2) // Individual timeout
              )
            ]);
             logger.debug(`[Cleanup] Task ${index + 1} completed.`);
          } catch (error) {
            logger.warn(`[Cleanup] Task ${index + 1} failed or timed out: ${error.message}`);
          }
        })
      ),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error('Global cleanup timeout')), timeout) // Global timeout
      )
    ]);

    logger.info('[Cleanup] Generic cleanup tasks completed successfully');
  } catch (error) {
    logger.warn(`[Cleanup] Generic cleanup process ended with error or timeout: ${error.message}`);
  } finally {
    cleanupTasks = []; // Clear tasks regardless of outcome
  }
}


// --- Storage-Specific Cleanup ---

// How often to run the storage cleanup check (e.g., every 15 minutes)
const STORAGE_CLEANUP_INTERVAL = 15 * 60 * 1000;
let storageCleanupTimer = null;

/**
 * Performs cleanup of stale storage resources by calling the adapter's method.
 * This is typically run periodically.
 */
async function runStorageCleanup() {
    logger.info('[Cleanup] Running periodic storage cleanup...');
    try {
        if (storageAdapter && typeof storageAdapter.cleanupStale === 'function') {
             await storageAdapter.cleanupStale();
             logger.info('[Cleanup] Storage adapter cleanup task finished.');
             // Additionally, run empty folder cleanup if using local storage
             if (config.storageType === 'local') {
                 await cleanupEmptyFolders(config.uploadDir);
             }
        } else {
             logger.warn('[Cleanup] Storage adapter or cleanupStale method not available.');
        }
    } catch (error) {
        logger.error(`[Cleanup] Error during periodic storage cleanup: ${error.message}`, error.stack);
    }
}

/**
 * Starts the periodic storage cleanup task.
 */
function startStorageCleanupInterval() {
  if (storageCleanupTimer) {
    clearInterval(storageCleanupTimer);
  }
  logger.info(`[Cleanup] Starting periodic storage cleanup interval (${STORAGE_CLEANUP_INTERVAL / 60000} minutes).`);
  // Run once immediately on start? Optional.
  // runStorageCleanup();
  storageCleanupTimer = setInterval(runStorageCleanup, STORAGE_CLEANUP_INTERVAL);
  storageCleanupTimer.unref(); // Allow process to exit if this is the only timer
}

/**
 * Stops the periodic storage cleanup task.
 */
function stopStorageCleanupInterval() {
   if (storageCleanupTimer) {
     clearInterval(storageCleanupTimer);
     storageCleanupTimer = null;
     logger.info('[Cleanup] Stopped periodic storage cleanup interval.');
   }
}

// Start interval automatically
// Note: Ensure storageAdapter is initialized before this might run effectively.
// Consider starting this interval after server initialization in server.js if needed.
if (!config.isDemoMode) { // Don't run cleanup in demo mode
    startStorageCleanupInterval();
} else {
     logger.info('[Cleanup] Periodic storage cleanup disabled in Demo Mode.');
}

// Stop interval on shutdown
process.on('SIGTERM', stopStorageCleanupInterval);
process.on('SIGINT', stopStorageCleanupInterval);


// --- Empty Folder Cleanup (Primarily for Local Storage) ---

/**
 * Recursively remove empty folders within a given directory.
 * Skips the special '.metadata' directory.
 * @param {string} dir - Directory path to clean.
 */
async function cleanupEmptyFolders(dir) {
  // Check if the path exists and is a directory first
  try {
      const stats = await fs.stat(dir);
      if (!stats.isDirectory()) {
          logger.debug(`[Cleanup] Skipping non-directory path for empty folder cleanup: ${dir}`);
          return;
      }
  } catch (err) {
      if (err.code === 'ENOENT') {
          logger.debug(`[Cleanup] Directory not found for empty folder cleanup: ${dir}`);
          return; // Directory doesn't exist, nothing to clean
      }
      logger.error(`[Cleanup] Error stating directory ${dir} for cleanup: ${err.message}`);
      return; // Don't proceed if we can't stat
  }


  logger.debug(`[Cleanup] Checking for empty folders within: ${dir}`);
  const isMetadataDir = path.basename(dir) === '.metadata';
  if (isMetadataDir) {
      logger.debug(`[Cleanup] Skipping cleanup of metadata directory itself: ${dir}`);
      return;
  }

  let entries;
  try {
      entries = await fs.readdir(dir, { withFileTypes: true });
  } catch (err) {
       logger.error(`[Cleanup] Failed to read directory ${dir} for empty folder cleanup: ${err.message}`);
       return; // Cannot proceed
  }

  // Recursively clean subdirectories first
  const subDirPromises = entries
    .filter(entry => entry.isDirectory() && entry.name !== '.metadata')
    .map(entry => cleanupEmptyFolders(path.join(dir, entry.name)));

  await Promise.all(subDirPromises);

  // Re-read directory contents after cleaning subdirectories
  try {
      entries = await fs.readdir(dir); // Just need names now
  } catch (err) {
       logger.error(`[Cleanup] Failed to re-read directory ${dir} after sub-cleanup: ${err.message}`);
       return;
  }

  // Check if directory is now empty (or only contains .metadata)
  const isEmpty = entries.length === 0 || (entries.length === 1 && entries[0] === '.metadata');

  if (isEmpty) {
    // Make sure we don't delete the main configured upload dir or the metadata dir
    const resolvedUploadDir = path.resolve(config.uploadDir);
    const resolvedCurrentDir = path.resolve(dir);

    if (resolvedCurrentDir !== resolvedUploadDir && path.basename(resolvedCurrentDir) !== '.metadata') {
      try {
        await fs.rmdir(resolvedCurrentDir);
        logger.info(`[Cleanup] Removed empty directory: ${resolvedCurrentDir}`);
      } catch (rmErr) {
        if (rmErr.code !== 'ENOENT') { // Ignore if already deleted
          logger.error(`[Cleanup] Failed to remove supposedly empty directory ${resolvedCurrentDir}: ${rmErr.message}`);
        }
      }
    } else {
        logger.debug(`[Cleanup] Skipping removal of root upload directory or metadata directory: ${resolvedCurrentDir}`);
    }
  }
}

// --- Export ---
module.exports = {
  registerCleanupTask,
  removeCleanupTask,
  executeCleanup,
  // Exporting runStorageCleanup might be useful for triggering manually if needed
  runStorageCleanup,
  startStorageCleanupInterval,
  stopStorageCleanupInterval,
  cleanupEmptyFolders // Export if needed elsewhere, though mainly used internally now
};