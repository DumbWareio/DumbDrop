const fs = require('fs');
const path = require('path');
const logger = require('./logger');

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
 * Calculate total size of files in a directory
 * @param {string} directoryPath - Path to directory
 * @returns {number} Total size in bytes
 */
function calculateDirectorySize(directoryPath) {
  let totalSize = 0;
  try {
    const files = fs.readdirSync(directoryPath);
    files.forEach(file => {
      const filePath = path.join(directoryPath, file);
      const stats = fs.statSync(filePath);
      if (stats.isFile()) {
        totalSize += stats.size;
      }
    });
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
      logger.info(`Created directory: ${directoryPath}`);
    }
    await fs.promises.access(directoryPath, fs.constants.W_OK);
    logger.success(`Directory is writable: ${directoryPath}`);
  } catch (err) {
    logger.error(`Directory error: ${err.message}`);
    throw new Error(`Failed to access or create directory: ${directoryPath}`);
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

  while (true) {
    try {
      const fileHandle = await fs.promises.open(finalPath, 'wx');
      return { path: finalPath, handle: fileHandle };
    } catch (err) {
      if (err.code === 'EEXIST') {
        finalPath = path.join(dir, `${baseName} (${counter})${ext}`);
        counter++;
      } else {
        throw err;
      }
    }
  }
}

/**
 * Get a unique folder path by appending numbers if folder exists
 * @param {string} folderPath - Original folder path
 * @returns {Promise<string>} Unique folder path
 */
async function getUniqueFolderPath(folderPath) {
  let counter = 1;
  let finalPath = folderPath;

  while (true) {
    try {
      await fs.promises.mkdir(finalPath, { recursive: false });
      return finalPath;
    } catch (err) {
      if (err.code === 'EEXIST') {
        finalPath = `${folderPath} (${counter})`;
        counter++;
      } else if (err.code === 'ENOENT') {
        await fs.promises.mkdir(path.dirname(finalPath), { recursive: true });
        continue;
      } else {
        throw err;
      }
    }
  }
}

module.exports = {
  formatFileSize,
  calculateDirectorySize,
  ensureDirectoryExists,
  getUniqueFilePath,
  getUniqueFolderPath
}; 