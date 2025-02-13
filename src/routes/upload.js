const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const path = require('path');
const { config } = require('../config');
const logger = require('../utils/logger');
const { getUniqueFilePath, getUniqueFolderPath } = require('../utils/fileUtils');
const { sendNotification } = require('../services/notifications');
const fs = require('fs');

// Store ongoing uploads
const uploads = new Map();
// Store folder name mappings for batch uploads with timestamps
const folderMappings = new Map();
// Store batch activity timestamps
const batchActivity = new Map();

/**
 * Validate batch ID format
 * @param {string} batchId - Batch ID to validate
 * @returns {boolean} True if valid
 */
function isValidBatchId(batchId) {
  return /^\d+-[a-z0-9]{9}$/.test(batchId);
}

// Add cleanup interval for inactive batches (5 minutes)
setInterval(() => {
  const now = Date.now();
  for (const [batchId, lastActivity] of batchActivity.entries()) {
    if (now - lastActivity >= 5 * 60 * 1000) {
      for (const key of folderMappings.keys()) {
        if (key.endsWith(`-${batchId}`)) {
          folderMappings.delete(key);
        }
      }
      batchActivity.delete(batchId);
      logger.info(`Cleaned up folder mappings for inactive batch: ${batchId}`);
    }
  }
}, 60000);

// Initialize upload
router.post('/init', async (req, res) => {
  const { filename, fileSize } = req.body;

  try {
    // Validate required fields
    if (!filename || typeof fileSize !== 'number') {
      return res.status(400).json({ 
        error: 'Missing required fields: filename and fileSize (number) are required' 
      });
    }

    // Convert fileSize to number if it's a string
    const size = parseInt(fileSize, 10);
    if (isNaN(size) || size <= 0) {
      return res.status(400).json({ 
        error: 'Invalid file size: must be a positive number' 
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

    // Generate batch ID
    const timestamp = Date.now();
    const randomStr = crypto.randomBytes(4).toString('hex').substring(0, 9);
    const batchId = `${timestamp}-${randomStr}`;

    // Update batch activity
    batchActivity.set(batchId, Date.now());

    // Sanitize filename
    const safeFilename = path.normalize(filename).replace(/^(\.\.(\/|\\|$))+/, '');
    
    // Validate file extension if configured
    if (config.allowedExtensions) {
      const fileExt = path.extname(safeFilename).toLowerCase();
      if (!config.allowedExtensions.includes(fileExt)) {
        return res.status(400).json({ 
          error: 'File type not allowed',
          allowedExtensions: config.allowedExtensions
        });
      }
    }

    const uploadId = crypto.randomBytes(16).toString('hex');
    let filePath = path.join(config.uploadDir, safeFilename);
    let fileHandle;
    
    try {
      // Handle file/folder paths
      const pathParts = safeFilename.split('/');
      
      if (pathParts.length > 1) {
        // Handle files within folders
        const originalFolderName = pathParts[0];
        const folderPath = path.join(config.uploadDir, originalFolderName);
        let newFolderName = folderMappings.get(`${originalFolderName}-${batchId}`);
        
        if (!newFolderName) {
          try {
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
        fileSize,
        bytesReceived: 0,
        writeStream: fileHandle.createWriteStream()
      });

      logger.info(`Initialized upload for ${path.relative(config.uploadDir, filePath)} (${size} bytes)`);
      res.json({ uploadId });
    } catch (err) {
      if (fileHandle) {
        await fileHandle.close().catch(() => {});
        fs.promises.unlink(filePath).catch(() => {});
      }
      throw err;
    }
  } catch (err) {
    logger.error(`Upload initialization failed: ${err.message}`);
    res.status(500).json({ error: 'Failed to initialize upload' });
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

  if (!upload) {
    return res.status(404).json({ error: 'Upload not found' });
  }

  try {
    // Update batch activity if batch ID provided
    const batchId = req.headers['x-batch-id'];
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
    
    logger.info(`Received chunk for ${upload.safeFilename}: ${progress}%`);

    // Check if upload is complete
    if (upload.bytesReceived >= upload.fileSize) {
      await new Promise((resolve, reject) => {
        upload.writeStream.end((err) => {
          if (err) reject(err);
          else resolve();
        });
      });
      uploads.delete(uploadId);
      logger.success(`Upload completed: ${upload.safeFilename}`);
      
      // Send notification
      await sendNotification(upload.safeFilename, upload.fileSize, config);
    }

    res.json({ 
      bytesReceived: upload.bytesReceived,
      progress
    });
  } catch (err) {
    logger.error(`Chunk upload failed: ${err.message}`);
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
    logger.info(`Upload cancelled: ${upload.safeFilename}`);
  }

  res.json({ message: 'Upload cancelled' });
});

module.exports = router; 