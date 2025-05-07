/**
 * File management route handlers.
 * Provides endpoints for listing and deleting files using the configured storage adapter.
 * Handles file downloads by either providing a presigned URL (S3) or streaming (local).
 */

const express = require('express');
const router = express.Router();
const path = require('path'); // Needed for sanitization
const fs = require('fs'); // Needed ONLY for local file streaming
const { storageAdapter } = require('../storage'); // Import the selected adapter
const logger = require('../utils/logger');
const { isDemoMode } = require('../utils/demoMode'); // Keep demo check if needed

/**
 * List all files from the storage backend.
 */
router.get('/', async (req, res) => {
  // Demo mode handling (simplified list)
  if (isDemoMode()) {
      logger.info('[DEMO /files] Listing demo files');
      // Return a mock list or call demoAdapter.listFiles() if implemented
      return res.json({
          files: [{ filename: 'demo_file.txt', size: 1234, formattedSize: '1.21KB', uploadDate: new Date().toISOString() }],
          totalFiles: 1,
          totalSize: 1234,
          message: 'Demo Mode: Showing mock file list'
      });
  }

  try {
    const files = await storageAdapter.listFiles();
    const totalSize = files.reduce((acc, file) => acc + (file.size || 0), 0);

    res.json({
      files: files,
      totalFiles: files.length,
      totalSize: totalSize
      // Note: formattedTotalSize could be calculated here if needed
    });
  } catch (err) {
    logger.error(`[Route /files GET] Failed to list files: ${err.message}`, err.stack);
    // Map common errors
    let statusCode = 500;
    let clientMessage = 'Failed to list files.';
    if (err.name === 'NoSuchBucket' || err.name === 'AccessDenied') { // S3 Specific
        clientMessage = 'Storage configuration error.';
    } else if (err.code === 'ENOENT') { // Local Specific
        clientMessage = 'Storage directory not found.';
    } else if (err.code === 'EACCES' || err.code === 'EPERM') { // Local Specific
         clientMessage = 'Storage permission error.';
    }
    res.status(statusCode).json({ error: clientMessage, details: err.message });
  }
});

/**
 * Get a download URL or stream a file.
 * For S3, returns a presigned URL.
 * For Local, streams the file content.
 */
router.get('/:filename/download', async (req, res) => {
  const rawFilename = req.params.filename;

  // Basic sanitization: Prevent directory traversal.
  // Adapters should also validate/sanitize keys/paths.
  const filename = path.basename(rawFilename);
  if (filename !== rawFilename || filename.includes('..')) {
     logger.error(`[Route /download] Invalid filename detected: ${rawFilename}`);
     return res.status(400).json({ error: 'Invalid filename' });
  }

  // Demo mode handling
  if (isDemoMode()) {
      logger.info(`[DEMO /download] Download request for ${filename}`);
      return res.json({
          message: 'Demo Mode: This would initiate download in production.',
          filename: filename
      });
  }

  try {
    const result = await storageAdapter.getDownloadUrlOrStream(filename);

    if (result.type === 'url') {
      // S3 Adapter returned a presigned URL
      logger.info(`[Route /download] Providing presigned URL for: ${filename}`);
      // Option 1: Redirect (Simple, but might hide URL from client)
      // res.redirect(result.value);

      // Option 2: Return URL in JSON (Gives client more control)
      res.json({ downloadUrl: result.value });

    } else if (result.type === 'path') {
      // Local Adapter returned a file path
      const filePath = result.value;
      logger.info(`[Route /download] Streaming local file: ${filePath}`);

      // Check if file still exists before streaming
      try {
         await fs.promises.access(filePath, fs.constants.R_OK);
      } catch (accessErr) {
         if (accessErr.code === 'ENOENT') {
            logger.warn(`[Route /download] Local file not found just before streaming: ${filePath}`);
            return res.status(404).json({ error: 'File not found' });
         }
          logger.error(`[Route /download] Cannot access local file for streaming ${filePath}: ${accessErr.message}`);
          return res.status(500).json({ error: 'Failed to access file for download' });
      }

      // Set headers for download
      res.setHeader('Content-Disposition', `attachment; filename="${filename}"`); // Use the sanitized basename
      res.setHeader('Content-Type', 'application/octet-stream'); // Generic type

      // Stream the file
      const fileStream = fs.createReadStream(filePath);

      fileStream.on('error', (streamErr) => {
        logger.error(`[Route /download] File streaming error for ${filePath}: ${streamErr.message}`);
        if (!res.headersSent) {
          // Try to send an error response if headers haven't been sent yet
          res.status(500).json({ error: 'Failed to stream file' });
        } else {
           // If headers already sent, we can only terminate the connection
           res.end();
        }
      });

      fileStream.pipe(res);

    } else {
      // Unknown result type from adapter
      logger.error(`[Route /download] Unknown result type from storage adapter: ${result.type}`);
      res.status(500).json({ error: 'Internal server error during download preparation' });
    }

  } catch (err) {
    logger.error(`[Route /download] Failed to get download for ${filename}: ${err.message}`, err.stack);
    let statusCode = 500;
    let clientMessage = 'Failed to initiate download.';

    // Use specific errors thrown by adapters if available
    if (err.message === 'File not found' || err.message === 'File not found in S3' || err.name === 'NoSuchKey' || err.code === 'ENOENT') {
        statusCode = 404;
        clientMessage = 'File not found.';
    } else if (err.message === 'Permission denied' || err.code === 'EACCES' || err.name === 'AccessDenied') {
        statusCode = 500; // Treat permission issues as internal server errors generally
        clientMessage = 'Storage permission error during download.';
    } else if (err.message === 'Invalid filename') {
         statusCode = 400;
         clientMessage = 'Invalid filename specified.';
    }

    // Avoid sending error if headers might have been partially sent by streaming
    if (!res.headersSent) {
        res.status(statusCode).json({ error: clientMessage, details: err.message });
    } else {
         logger.warn(`[Route /download] Error occurred after headers sent for ${filename}. Cannot send JSON error.`);
         res.end(); // Terminate response if possible
    }
  }
});


/**
 * Delete a file from the storage backend.
 */
router.delete('/:filename', async (req, res) => {
  const rawFilename = req.params.filename;

  // Basic sanitization
  const filename = path.basename(rawFilename);
   if (filename !== rawFilename || filename.includes('..')) {
     logger.error(`[Route /delete] Invalid filename detected: ${rawFilename}`);
     return res.status(400).json({ error: 'Invalid filename' });
  }

  // Demo mode handling
  if (isDemoMode()) {
      logger.info(`[DEMO /delete] Delete request for ${filename}`);
      // Call demoAdapter.deleteFile(filename) if implemented?
      return res.json({ message: 'File deleted (Demo)', filename: filename });
  }

  logger.info(`[Route /delete] Received delete request for: ${filename}`);

  try {
    await storageAdapter.deleteFile(filename);
    res.json({ message: 'File deleted successfully' });
  } catch (err) {
    logger.error(`[Route /delete] Failed to delete file ${filename}: ${err.message}`, err.stack);
    let statusCode = 500;
    let clientMessage = 'Failed to delete file.';

    // Use specific errors thrown by adapters if available
    if (err.message === 'File not found' || err.message === 'File not found in S3' || err.name === 'NoSuchKey' || err.code === 'ENOENT') {
        statusCode = 404;
        clientMessage = 'File not found.';
    } else if (err.message === 'Permission denied' || err.code === 'EACCES' || err.name === 'AccessDenied') {
        statusCode = 500;
        clientMessage = 'Storage permission error during delete.';
     } else if (err.message === 'Invalid filename') {
         statusCode = 400;
         clientMessage = 'Invalid filename specified.';
    }

    res.status(statusCode).json({ error: clientMessage, details: err.message });
  }
});

module.exports = router;