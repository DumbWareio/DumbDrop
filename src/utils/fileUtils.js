/**
 * File system utility functions for file operations.
 * Handles file paths, sizes, directory operations, and path mapping.
 * Provides helper functions for file system operations.
 */

const fs = require('fs');
const path = require('path');
const logger = require('./logger');
const { config } = require('../config');

/**
 * Get display path for logs
 * @param {string} internalPath - Internal Docker path
 * @returns {string} Display path for host machine
 */
function getDisplayPath(internalPath) {
  if (!internalPath.startsWith(config.uploadDir)) return internalPath;
  
  // Replace the container path with the host path
  const relativePath = path.relative(config.uploadDir, internalPath);
  return path.join(config.uploadDisplayPath, relativePath);
}

/**
 * Format file size to human readable format
 * @param {number} bytes - Size in bytes
 * @param {string} [unit] - Force specific unit (B, KB, MB, GB, TB)
 * @returns {string} Formatted size with unit
 */
function formatFileSize(bytes, unit = null) {
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let size = bytes;
  let unitIndex = 0;

  // If a specific unit is requested
  if (unit) {
    const requestedUnit = unit.toUpperCase();
    const unitIndex = units.indexOf(requestedUnit);
    if (unitIndex !== -1) {
      size = bytes / Math.pow(1024, unitIndex);
      return size.toFixed(2) + requestedUnit;
    }
  }

  // Auto format to nearest unit
  while (size >= 1024 && unitIndex < units.length - 1) {
    size /= 1024;
    unitIndex++;
  }

  return size.toFixed(2) + units[unitIndex];
}

/**
 * Calculate total size of files in a directory recursively
 * @param {string} directoryPath - Path to directory
 * @returns {Promise<number>} Total size in bytes
 */
async function calculateDirectorySize(directoryPath) {
  let totalSize = 0;
  try {
    const files = await fs.promises.readdir(directoryPath);
    const fileSizePromises = files.map(async file => {
      const filePath = path.join(directoryPath, file);
      const stats = await fs.promises.stat(filePath);
      if (stats.isFile()) {
        return stats.size;
      } else if (stats.isDirectory()) {
        // Recursively calculate size for subdirectories
        return await calculateDirectorySize(filePath);
      }
      return 0;
    });
    
    const sizes = await Promise.all(fileSizePromises);
    totalSize = sizes.reduce((acc, size) => acc + size, 0);
  } catch (err) {
    logger.error(`Failed to calculate directory size: ${err.message}`);
  }
  return totalSize;
}

/**
 * Ensure a directory exists and is writable
 * @param {string} directoryPath - Path to directory
 * @returns {Promise<void>}
 */
async function ensureDirectoryExists(directoryPath) {
  try {
    if (!fs.existsSync(directoryPath)) {
      await fs.promises.mkdir(directoryPath, { recursive: true });
      logger.info(`Created directory: ${getDisplayPath(directoryPath)}`);
    }
    await fs.promises.access(directoryPath, fs.constants.W_OK);
    logger.success(`Directory is writable: ${getDisplayPath(directoryPath)}`);
  } catch (err) {
    logger.error(`Directory error: ${err.message}`);
    throw new Error(`Failed to access or create directory: ${getDisplayPath(directoryPath)}`);
  }
}

/**
 * Get a unique file path by appending numbers if file exists
 * @param {string} filePath - Original file path
 * @returns {Promise<{path: string, handle: FileHandle}>} Unique path and file handle
 */
async function getUniqueFilePath(filePath) {
  const dir = path.dirname(filePath);
  const ext = path.extname(filePath);
  const baseName = path.basename(filePath, ext);
  let counter = 1;
  let finalPath = filePath;
  let fileHandle = null;

  // Try until we find a unique path or hit an error
  let pathFound = false;
  while (!pathFound) {
    try {
      fileHandle = await fs.promises.open(finalPath, 'wx');
      pathFound = true;
    } catch (err) {
      if (err.code === 'EEXIST') {
        finalPath = path.join(dir, `${baseName} (${counter})${ext}`);
        counter++;
      } else {
        throw err;
      }
    }
  }
  
  // Log using display path
  logger.info(`Using unique path: ${getDisplayPath(finalPath)}`);
  return { path: finalPath, handle: fileHandle };
}

/**
 * Get a unique folder path by appending numbers if folder exists
 * @param {string} folderPath - Original folder path
 * @returns {Promise<string>} Unique folder path
 */
async function getUniqueFolderPath(folderPath) {
  let counter = 1;
  let finalPath = folderPath;
  let pathFound = false;

  while (!pathFound) {
    try {
      await fs.promises.mkdir(finalPath, { recursive: false });
      pathFound = true;
    } catch (err) {
      if (err.code === 'EEXIST') {
        finalPath = `${folderPath} (${counter})`;
        counter++;
      } else {
        throw err;
      }
    }
  }
  return finalPath;
}

module.exports = {
  formatFileSize,
  calculateDirectorySize,
  ensureDirectoryExists,
  getUniqueFilePath,
  getUniqueFolderPath
}; 