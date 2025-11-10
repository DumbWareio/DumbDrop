/**
 * File system utility functions for file operations.
 * Handles file paths, sizes, directory operations, and path mapping.
 * Provides helper functions for file system operations.
 */

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
  
  // Log using actual path
  logger.info(`Using unique path: ${finalPath}`);
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

/**
 * Comprehensive filename sanitization for safe file storage
 * Removes spaces, special characters, and normalizes to ASCII-safe characters
 * @param {string} fileName - Original filename
 * @returns {string} Sanitized filename safe for all operating systems
 */
function sanitizeFilenameSafe(fileName) {
  if (!fileName || typeof fileName !== 'string') {
    return 'unnamed_file';
  }

  // Get the file extension first (preserve it)
  const ext = path.extname(fileName);
  let baseName = path.basename(fileName, ext);

  // If no base name after removing extension, use a default
  if (!baseName || baseName.trim() === '') {
    baseName = 'unnamed_file';
  }

  // Step 1: Normalize Unicode characters to ASCII equivalents
  baseName = baseName
    .normalize('NFD') // Decompose Unicode characters
    .replace(/[\u0300-\u036f]/g, '') // Remove diacritical marks
    // eslint-disable-next-line no-control-regex
    .replace(/[^\x00-\x7F]/g, ''); // Remove non-ASCII characters

  // Step 2: Replace spaces and common separators with underscores
  baseName = baseName
    .replace(/\s+/g, '_') // Replace all whitespace with underscores
    .replace(/[+\-\s]+/g, '_'); // Replace + and - with underscores

  // Step 3: Remove or replace problematic characters
  baseName = baseName
    .replace(/[<>:"/\\|?*]/g, '') // Remove filesystem reserved characters
    .replace(/[`"'$|;&<>(){}[\]]/g, '') // Remove shell/command problematic chars
    .replace(/[~#%&*{}\\:<>?/+|"']/g, '') // Remove additional problematic chars
    .replace(/[^\w\-_.]/g, '') // Keep only word chars, hyphens, underscores, dots
    .replace(/_{2,}/g, '_') // Replace multiple underscores with single
    .replace(/^[._-]+/, '') // Remove leading dots, underscores, hyphens
    .replace(/[._-]+$/, ''); // Remove trailing dots, underscores, hyphens

  // Step 4: Ensure the filename isn't empty and isn't reserved
  if (!baseName || baseName.length === 0) {
    baseName = 'file';
  }

  // Step 5: Check for Windows reserved names
  const reservedNames = [
    'CON', 'PRN', 'AUX', 'NUL',
    'COM1', 'COM2', 'COM3', 'COM4', 'COM5', 'COM6', 'COM7', 'COM8', 'COM9',
    'LPT1', 'LPT2', 'LPT3', 'LPT4', 'LPT5', 'LPT6', 'LPT7', 'LPT8', 'LPT9'
  ];
  
  if (reservedNames.includes(baseName.toUpperCase())) {
    baseName = baseName + '_file';
  }

  // Step 6: Limit length (keep reasonable length, reserve space for extension)
  const maxLength = 200; // Leave room for path length limits
  if (baseName.length > maxLength) {
    baseName = baseName.substring(0, maxLength);
  }

  // Step 7: Clean up the extension too
  let cleanExt = ext;
  if (cleanExt) {
    cleanExt = cleanExt
      .replace(/[^a-zA-Z0-9.]/g, '') // Only allow alphanumeric and dots in extension
      .toLowerCase(); // Normalize to lowercase
    
    // Ensure extension starts with a dot
    if (cleanExt && !cleanExt.startsWith('.')) {
      cleanExt = '.' + cleanExt;
    }
  }

  const finalName = baseName + cleanExt;
  
  // Final safety check - if somehow we end up with an empty name
  if (!finalName || finalName === cleanExt) {
    return 'file' + (cleanExt || '.txt');
  }

  return finalName;
}

/**
 * Sanitize a file path while preserving directory structure
 * Each path component is individually sanitized
 * @param {string} filePath - Original file path
 * @returns {string} Sanitized file path
 */
function sanitizePathPreserveDirsSafe(filePath) {
  if (!filePath || typeof filePath !== 'string') {
    return 'unnamed_file.txt';
  }

  // Split on forward slashes, sanitize each part, and rejoin
  return filePath
    .split('/')
    .filter(part => part.length > 0 && part !== '.' && part !== '..') // Remove empty parts and path navigation tokens
    .map(part => sanitizeFilenameSafe(part))
    .join('/');
}

/**
 * Legacy filename sanitization (kept for compatibility)
 * @deprecated Use sanitizeFilenameSafe instead
 */
function sanitizeFilename(fileName) {
  const sanitized = fileName.replace(/[<>:"/\\|?*]+/g, '').replace(/["`$|;&<>]/g, '');
  return sanitized;
}

/**
 * Legacy path sanitization (kept for compatibility)
 * @deprecated Use sanitizePathPreserveDirsSafe instead
 */
function sanitizePathPreserveDirs(filePath) {
  // Split on forward slashes, sanitize each part, and rejoin
  return filePath
    .split('/')
    .map(part => sanitizeFilename(part))
    .join('/');
}

/**
 * Validate batch ID format
 * @param {string} batchId - Batch ID to validate
 * @returns {boolean} True if valid (matches timestamp-9_alphanumeric format)
 */
function isValidBatchId(batchId) {
  if (!batchId) return false;
  return /^\d+-[a-z0-9]{9}$/.test(batchId);
}

/**
 * Check if a file path is within the upload directory
 * Works with both existing and non-existing files, and handles Docker bind mounts correctly
 * This function does NOT require the file to exist, making it suitable for upload validation
 * @param {string} filePath - The file path to check (may not exist yet)
 * @param {string} uploadDir - The upload directory (must exist)
 * @param {boolean} requireExists - If true, file must exist (default: false for compatibility with uploads)
 * @returns {boolean} True if the path is within the upload directory
 */
function isPathWithinUploadDir(filePath, uploadDir, requireExists = false) {
  try {
    // Resolve the upload directory to its real path (should always exist)
    // This handles symlinks in the upload directory path
    let realUploadDir;
    try {
      realUploadDir = fs.realpathSync(uploadDir);
    } catch (err) {
      logger.error(`Upload directory does not exist or is inaccessible: ${uploadDir}`);
      return false;
    }
    
    // For the file path, we need different handling based on whether it exists
    let resolvedFilePath;
    if (requireExists) {
      // When requireExists is true, the file must exist
      if (!fs.existsSync(filePath)) {
        // File must exist but doesn't - return false immediately
        return false;
      }
      // File exists, resolve symlinks for security
      try {
        resolvedFilePath = fs.realpathSync(filePath);
      } catch (err) {
        logger.error(`Failed to resolve existing file path: ${filePath}`);
        return false;
      }
    } else {
      // For non-existing files (like during upload), use path.resolve
      // This normalizes the path without requiring it to exist
      resolvedFilePath = path.resolve(filePath);
      
      // Normalize both paths to use consistent separators
      resolvedFilePath = path.normalize(resolvedFilePath);
    }
    
    // Normalize the upload directory path as well
    realUploadDir = path.normalize(realUploadDir);
    
    // Use path.relative() to check if file path is relative to upload dir
    // This is more reliable than startsWith() checks, especially with bind mounts
    const relativePath = path.relative(realUploadDir, resolvedFilePath);
    
    // If relative path is empty, the paths are the same (upload dir itself) - allow it
    if (relativePath === '') {
      return true;
    }
    
    // If relative path starts with '..', it's outside the upload directory
    // This catches path traversal attempts
    if (relativePath.startsWith('..')) {
      return false;
    }
    
    // Additional check: On Windows, ensure we're on the same drive
    if (process.platform === 'win32') {
      const fileDrive = resolvedFilePath.split(':')[0];
      const uploadDrive = realUploadDir.split(':')[0];
      if (fileDrive !== uploadDrive) {
        return false;
      }
    }
    
    // If we get here, the path is within the upload directory
    return true;
  } catch (err) {
    logger.error(`Path validation error: ${err.message}`, err);
    return false;
  }
}

module.exports = {
  formatFileSize,
  calculateDirectorySize,
  ensureDirectoryExists,
  getUniqueFilePath,
  getUniqueFolderPath,
  sanitizeFilename,
  sanitizePathPreserveDirs,
  sanitizeFilenameSafe,
  sanitizePathPreserveDirsSafe,
  isValidBatchId,
  isPathWithinUploadDir
}; 