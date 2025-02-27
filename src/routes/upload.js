/**
 * File upload route handlers and batch upload management.
 * Handles file uploads, chunked transfers, and folder creation.
 * Manages upload sessions, batch timeouts, and cleanup.
 */

const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const path = require('path');
const { config } = require('../config');
const logger = require('../utils/logger');
const { getUniqueFilePath, getUniqueFolderPath } = require('../utils/fileUtils');
const { sendNotification } = require('../services/notifications');
const fs = require('fs');
const { cleanupIncompleteUploads } = require('../utils/cleanup');
const { isDemoMode, createMockUploadResponse } = require('../utils/demoMode');

// Store ongoing uploads
const uploads = new Map();
// Store folder name mappings for batch uploads with timestamps
const folderMappings = new Map();
// Store batch activity timestamps
const batchActivity = new Map();
// Store upload to batch mappings
const uploadToBatch = new Map();

const BATCH_TIMEOUT = 30 * 60 * 1000; // 30 minutes

let cleanupInterval;

/**
 * Start the cleanup interval for inactive batches
 * @returns {NodeJS.Timeout} The interval handle
 */
function startBatchCleanup() {
  if (cleanupInterval) {
    clearInterval(cleanupInterval);
  }
  
  cleanupInterval = setInterval(() => {
    const now = Date.now();
    logger.info(`Running batch cleanup, checking ${batchActivity.size} active batches`);
    
    for (const [batchId, lastActivity] of batchActivity.entries()) {
      if (now - lastActivity >= BATCH_TIMEOUT) {
        logger.info(`Cleaning up inactive batch: ${batchId}`);
        batchActivity.delete(batchId);
      }
    }
  }, 5 * 60 * 1000); // 5 minutes
  
  return cleanupInterval;
}

/**
 * Stop the batch cleanup interval
 */
function stopBatchCleanup() {
  if (cleanupInterval) {
    clearInterval(cleanupInterval);
    cleanupInterval = null;
  }
}

// Start cleanup interval unless disabled
if (!process.env.DISABLE_BATCH_CLEANUP) {
  startBatchCleanup();
}

// Run cleanup periodically
const CLEANUP_INTERVAL = 5 * 60 * 1000; // 5 minutes
const cleanupTimer = setInterval(() => {
  cleanupIncompleteUploads(uploads, uploadToBatch, batchActivity)
    .catch(err => logger.error(`Cleanup failed: ${err.message}`));
}, CLEANUP_INTERVAL);

// Handle cleanup timer errors
cleanupTimer.unref(); // Don't keep process alive just for cleanup
process.on('SIGTERM', () => {
  clearInterval(cleanupTimer);
  // Final cleanup
  cleanupIncompleteUploads(uploads, uploadToBatch, batchActivity)
    .catch(err => logger.error(`Final cleanup failed: ${err.message}`));
});

/**
 * Log the current state of uploads and mappings
 * @param {string} context - The context where this log is being called from
 */
function logUploadState(context) {
  logger.debug(`Upload State [${context}]:
    Active Uploads: ${uploads.size}
    Active Batches: ${batchActivity.size}
    Folder Mappings: ${folderMappings.size}
    Upload-Batch Mappings: ${uploadToBatch.size}
  `);
}

/**
 * Validate batch ID format
 * @param {string} batchId - Batch ID to validate
 * @returns {boolean} True if valid
 */
function isValidBatchId(batchId) {
  return /^\d+-[a-z0-9]{9}$/.test(batchId);
}

// Initialize upload
router.post('/init', async (req, res) => {
  const { filename, fileSize } = req.body;
  const clientBatchId = req.headers['x-batch-id'];

  try {
    // Log request details for debugging
    if (process.env.DEBUG === 'true' || process.env.NODE_ENV === 'development') {
      logger.info(`Upload init request:
        Filename: ${filename}
        Size: ${fileSize} (${typeof fileSize})
        Batch ID: ${clientBatchId || 'none'}
      `);
    } else {
      logger.info(`Upload init request: ${filename} (${fileSize} bytes)`);
    }

    // Validate required fields with detailed errors
    if (!filename) {
      return res.status(400).json({ 
        error: 'Missing filename',
        details: 'The filename field is required'
      });
    }
    
    if (fileSize === undefined || fileSize === null) {
      return res.status(400).json({ 
        error: 'Missing fileSize',
        details: 'The fileSize field is required'
      });
    }

    // Convert fileSize to number if it's a string
    const size = Number(fileSize);
    if (isNaN(size) || size < 0) { // Changed from size <= 0 to allow zero-byte files
      return res.status(400).json({ 
        error: 'Invalid file size',
        details: `File size must be a non-negative number, received: ${fileSize} (${typeof fileSize})`
      });
    }

    // Validate file size
    const maxSizeInBytes = config.maxFileSize;
    if (size > maxSizeInBytes) {
      const message = `File size ${size} bytes exceeds limit of ${maxSizeInBytes} bytes`;
      logger.warn(message);
      return res.status(413).json({ 
        error: 'File too large',
        message,
        limit: maxSizeInBytes,
        limitInMB: Math.floor(maxSizeInBytes / (1024 * 1024))
      });
    }

    // Generate batch ID from header or create new one
    const batchId = req.headers['x-batch-id'] || `${Date.now()}-${crypto.randomBytes(4).toString('hex').substring(0, 9)}`;

    // Validate batch ID if provided in header
    if (req.headers['x-batch-id'] && !isValidBatchId(batchId)) {
      return res.status(400).json({ 
        error: 'Invalid batch ID format',
        details: `Batch ID must match format: timestamp-[9 alphanumeric chars], received: ${batchId}`
      });
    }

    // Update batch activity
    batchActivity.set(batchId, Date.now());

    // Sanitize filename and convert to forward slashes
    const safeFilename = path.normalize(filename)
      .replace(/^(\.\.(\/|\\|$))+/, '')
      .replace(/\\/g, '/')
      .replace(/^\/+/, ''); // Remove leading slashes
    
    // Log sanitized filename
    logger.info(`Processing upload: ${safeFilename}`);
    
    // Validate file extension if configured
    if (config.allowedExtensions) {
      const fileExt = path.extname(safeFilename).toLowerCase();
      if (!config.allowedExtensions.includes(fileExt)) {
        return res.status(400).json({ 
          error: 'File type not allowed',
          allowedExtensions: config.allowedExtensions,
          receivedExtension: fileExt
        });
      }
    }

    const uploadId = crypto.randomBytes(16).toString('hex');
    let filePath = path.join(config.uploadDir, safeFilename);
    let fileHandle;
    
    try {
      // Handle file/folder paths
      const pathParts = safeFilename.split('/').filter(Boolean); // Remove empty parts
      
      if (pathParts.length > 1) {
        // Handle files within folders
        const originalFolderName = pathParts[0];
        const folderPath = path.join(config.uploadDir, originalFolderName);
        let newFolderName = folderMappings.get(`${originalFolderName}-${batchId}`);
        
        if (!newFolderName) {
          try {
            // First ensure parent directories exist
            await fs.promises.mkdir(path.dirname(folderPath), { recursive: true });
            // Then try to create the target folder
            await fs.promises.mkdir(folderPath, { recursive: false });
            newFolderName = originalFolderName;
          } catch (err) {
            if (err.code === 'EEXIST') {
              const uniqueFolderPath = await getUniqueFolderPath(folderPath);
              newFolderName = path.basename(uniqueFolderPath);
              logger.info(`Folder "${originalFolderName}" exists, using "${newFolderName}"`);
            } else {
              throw err;
            }
          }
          
          folderMappings.set(`${originalFolderName}-${batchId}`, newFolderName);
        }

        pathParts[0] = newFolderName;
        filePath = path.join(config.uploadDir, ...pathParts);
        
        // Ensure all parent directories exist
        await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
      }

      // Get unique file path and handle
      const result = await getUniqueFilePath(filePath);
      filePath = result.path;
      fileHandle = result.handle;
      
      // Create upload entry
      uploads.set(uploadId, {
        safeFilename: path.relative(config.uploadDir, filePath),
        filePath,
        fileSize: size,
        bytesReceived: 0,
        writeStream: fileHandle.createWriteStream()
      });
      
      // Associate upload with batch
      uploadToBatch.set(uploadId, batchId);

      logger.info(`Initialized upload for ${path.relative(config.uploadDir, filePath)} (${size} bytes)`);
      
      // Log state after initialization
      logUploadState('After Upload Init');

      // Handle zero-byte files immediately
      if (size === 0) {
        const upload = uploads.get(uploadId);
        upload.writeStream.end();
        uploads.delete(uploadId);
        logger.success(`Completed zero-byte file upload: ${upload.safeFilename}`);
        await sendNotification(upload.safeFilename, 0, config);
      }

      // Send response
      return res.json({ uploadId });

    } catch (err) {
      if (fileHandle) {
        await fileHandle.close().catch(() => {});
        fs.promises.unlink(filePath).catch(() => {});
      }
      throw err;
    }
  } catch (err) {
    logger.error(`Upload initialization failed:
      Error: ${err.message}
      Stack: ${err.stack}
      Filename: ${filename}
      Size: ${fileSize}
      Batch ID: ${clientBatchId || 'none'}
    `);
    return res.status(500).json({ 
      error: 'Failed to initialize upload',
      details: err.message
    });
  }
});

// Upload chunk
router.post('/chunk/:uploadId', express.raw({ 
  limit: '10mb', 
  type: 'application/octet-stream' 
}), async (req, res) => {
  const { uploadId } = req.params;
  const upload = uploads.get(uploadId);
  const chunkSize = req.body.length;
  const batchId = req.headers['x-batch-id'];

  if (!upload) {
    logger.warn(`Upload not found: ${uploadId}, Batch ID: ${batchId || 'none'}`);
    return res.status(404).json({ error: 'Upload not found' });
  }

  try {
    // Update batch activity if batch ID provided
    if (batchId && isValidBatchId(batchId)) {
      batchActivity.set(batchId, Date.now());
    }

    // Write chunk
    await new Promise((resolve, reject) => {
      upload.writeStream.write(Buffer.from(req.body), (err) => {
        if (err) reject(err);
        else resolve();
      });
    });
    upload.bytesReceived += chunkSize;

    // Calculate progress, ensuring it doesn't exceed 100%
    const progress = Math.min(
      Math.round((upload.bytesReceived / upload.fileSize) * 100),
      100
    );
    
    logger.debug(`Chunk received:
      File: ${upload.safeFilename}
      Progress: ${progress}%
      Bytes Received: ${upload.bytesReceived}/${upload.fileSize}
      Chunk Size: ${chunkSize}
      Upload ID: ${uploadId}
      Batch ID: ${batchId || 'none'}
    `);

    // Check if upload is complete
    if (upload.bytesReceived >= upload.fileSize) {
      await new Promise((resolve, reject) => {
        upload.writeStream.end((err) => {
          if (err) reject(err);
          else resolve();
        });
      });
      uploads.delete(uploadId);
      
      // Format completion message based on debug mode
      if (process.env.DEBUG === 'true' || process.env.NODE_ENV === 'development') {
        logger.success(`Upload completed:
          File: ${upload.safeFilename}
          Size: ${upload.fileSize}
          Upload ID: ${uploadId}
          Batch ID: ${batchId || 'none'}
        `);
      } else {
        logger.success(`Upload completed: ${upload.safeFilename} (${upload.fileSize} bytes)`);
      }
      
      // Send notification
      await sendNotification(upload.safeFilename, upload.fileSize, config);
      logUploadState('After Upload Complete');
    }

    res.json({ 
      bytesReceived: upload.bytesReceived,
      progress
    });
  } catch (err) {
    logger.error(`Chunk upload failed:
      Error: ${err.message}
      Stack: ${err.stack}
      File: ${upload.safeFilename}
      Upload ID: ${uploadId}
      Batch ID: ${batchId || 'none'}
      Bytes Received: ${upload.bytesReceived}/${upload.fileSize}
    `);
    res.status(500).json({ error: 'Failed to process chunk' });
  }
});

// Cancel upload
router.post('/cancel/:uploadId', async (req, res) => {
  const { uploadId } = req.params;
  const upload = uploads.get(uploadId);

  if (upload) {
    upload.writeStream.end();
    try {
      await fs.promises.unlink(upload.filePath);
    } catch (err) {
      logger.error(`Failed to delete incomplete upload: ${err.message}`);
    }
    uploads.delete(uploadId);
    uploadToBatch.delete(uploadId);
    logger.info(`Upload cancelled: ${upload.safeFilename}`);
  }

  res.json({ message: 'Upload cancelled' });
});

module.exports = {
  router,
  startBatchCleanup,
  stopBatchCleanup,
  // Export for testing
  batchActivity,
  BATCH_TIMEOUT
}; 