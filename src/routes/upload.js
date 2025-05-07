/**
 * File upload route handlers.
 * Delegates storage operations to the configured storage adapter.
 * Handles multipart uploads via adapter logic.
 */

const express = require('express');
const router = express.Router();
const path = require('path'); // Still needed for extension checks
const { config } = require('../config');
const logger = require('../utils/logger');
const { storageAdapter } = require('../storage'); // Import the adapter factory's result
const { isDemoMode } = require('../utils/demoMode'); // Keep demo check for specific route behavior if needed

// --- Routes ---

// Initialize upload
router.post('/init', async (req, res) => {
  if (isDemoMode() && config.storageType !== 's3') { // S3 demo might still hit the adapter for presigned URLs etc.
                                                   // but local demo can be simpler.
     const { filename = 'demo_file.txt', fileSize = 0 } = req.body;
     const demoUploadId = 'demo-' + Math.random().toString(36).substr(2, 9);
     logger.info(`[DEMO /init] Req for ${filename}, size ${fileSize}. ID ${demoUploadId}`);
     if (Number(fileSize) === 0) {
        logger.success(`[DEMO /init] Sim complete zero-byte: ${filename}`);
     }
     return res.json({ uploadId: demoUploadId });
  }

  const { filename, fileSize } = req.body;
  const clientBatchId = req.headers['x-batch-id'];

  if (!filename) return res.status(400).json({ error: 'Missing filename' });
  if (fileSize === undefined || fileSize === null) return res.status(400).json({ error: 'Missing fileSize' });
  const size = Number(fileSize);
  if (isNaN(size) || size < 0) return res.status(400).json({ error: 'Invalid file size' });

  if (size > config.maxFileSize) {
    logger.warn(`Upload rejected: File size ${size} exceeds limit ${config.maxFileSize} for ${filename}`);
    return res.status(413).json({ error: 'File too large', limit: config.maxFileSize });
  }

  if (config.allowedExtensions && config.allowedExtensions.length > 0) {
    const fileExt = path.extname(filename).toLowerCase();
    if (!fileExt || !config.allowedExtensions.includes(fileExt)) {
      logger.warn(`Upload rejected: File type not allowed: ${filename} (Ext: ${fileExt || 'none'})`);
      return res.status(400).json({ error: 'File type not allowed', receivedExtension: fileExt || 'none' });
    }
    logger.debug(`File extension ${fileExt} allowed for ${filename}`);
  }

  try {
    const result = await storageAdapter.initUpload(filename, size, clientBatchId);
    res.json({ uploadId: result.uploadId });
  } catch (err) {
    logger.error(`[Route /init] Upload initialization failed for "${filename}": ${err.name} - ${err.message}`, err.stack);
    let statusCode = 500;
    let clientMessage = 'Failed to initialize upload.';

    if (err.message.includes('Invalid batch ID format')) {
        statusCode = 400; clientMessage = err.message;
    } else if (err.name === 'NoSuchBucket' || err.name === 'AccessDenied') {
        statusCode = 500; clientMessage = 'Storage configuration error.';
    } else if (err.code === 'EACCES' || err.code === 'EPERM' || err.message.includes('writable') || err.message.includes('metadata directory')) {
         statusCode = 500; clientMessage = 'Storage permission or access error.';
    } else if (err.message.includes('S3 Client configuration failed')) {
        statusCode = 503; clientMessage = 'Storage service unavailable or misconfigured.';
    }
    res.status(statusCode).json({ error: clientMessage, details: config.nodeEnv === 'development' ? err.message : undefined });
  }
});

// Upload chunk
router.post('/chunk/:uploadId', express.raw({
  limit: config.maxFileSize + (10 * 1024 * 1024),
  type: 'application/octet-stream'
}), async (req, res) => {
  const { uploadId } = req.params;
  const chunk = req.body;
  const partNumber = parseInt(req.query.partNumber, 10); // Ensure partNumber is parsed

  if (isNaN(partNumber) || partNumber < 1) {
     logger.error(`[Route /chunk] Invalid partNumber for ${uploadId}: ${req.query.partNumber}`);
     return res.status(400).json({ error: 'Missing or invalid partNumber query parameter (must be >= 1)' });
  }

  if (isDemoMode() && config.storageType !== 's3') {
      logger.debug(`[DEMO /chunk] Chunk for ${uploadId}, part ${partNumber}, size ${chunk?.length || 0}`);
      const demoProgress = Math.min(100, (Math.random() * 50) + (partNumber * 10) ); // Simulate increasing progress
      const completed = demoProgress >= 100;
      if (completed) logger.info(`[DEMO /chunk] Sim completion for ${uploadId}`);
      return res.json({ bytesReceived: 0, progress: demoProgress, completed });
  }

  if (!chunk || chunk.length === 0) {
    logger.warn(`[Route /chunk] Empty chunk for ${uploadId}, part ${partNumber}`);
    return res.status(400).json({ error: 'Empty chunk received' });
  }

  try {
    const result = await storageAdapter.storeChunk(uploadId, chunk, partNumber);

    if (result.completed) {
      logger.info(`[Route /chunk] Part ${partNumber} for ${uploadId} triggered completion. Finalizing...`);
      try {
          const completionResult = await storageAdapter.completeUpload(uploadId);
          logger.success(`[Route /chunk] Finalized upload ${uploadId}. Path/Key: ${completionResult.finalPath}`);
          return res.json({ bytesReceived: result.bytesReceived, progress: 100, completed: true });
      } catch (completionError) {
         logger.error(`[Route /chunk] CRITICAL: Failed to finalize ${uploadId} after part ${partNumber}: ${completionError.message}`, completionError.stack);
         return res.status(500).json({ error: 'Upload chunk received, but failed to finalize.', details: config.nodeEnv === 'development' ? completionError.message : undefined });
      }
    } else {
      res.json({ bytesReceived: result.bytesReceived, progress: result.progress, completed: false });
    }
  } catch (err) {
    logger.error(`[Route /chunk] Chunk upload failed for ${uploadId}, part ${partNumber}: ${err.name} - ${err.message}`, err.stack);
    let statusCode = 500;
    let clientMessage = 'Failed to process chunk.';

    if (err.message.includes('Upload session not found') || err.name === 'NoSuchUpload' || err.code === 'ENOENT' || err.name === 'NotFound' || err.name === 'NoSuchKey') {
      statusCode = 404; clientMessage = 'Upload session not found or already completed/aborted.';
    } else if (err.name === 'InvalidPart' || err.name === 'InvalidPartOrder') {
       statusCode = 400; clientMessage = 'Invalid upload chunk sequence or data.';
    } else if (err.name === 'SlowDown' || (err.$metadata && err.$metadata.httpStatusCode === 503) ) {
       statusCode = 429; clientMessage = 'Storage provider rate limit exceeded, please try again later.';
    } else if (err.code === 'EACCES' || err.code === 'EPERM' ) {
        statusCode = 500; clientMessage = 'Storage permission error while writing chunk.';
    }
    res.status(statusCode).json({ error: clientMessage, details: config.nodeEnv === 'development' ? err.message : undefined });
  }
});

// Cancel upload
router.post('/cancel/:uploadId', async (req, res) => {
  const { uploadId } = req.params;

  if (isDemoMode() && config.storageType !== 's3') {
      logger.info(`[DEMO /cancel] Request for ${uploadId}`);
      return res.json({ message: 'Upload cancelled (Demo)' });
  }

  logger.info(`[Route /cancel] Cancel request for upload: ${uploadId}`);
  try {
    await storageAdapter.abortUpload(uploadId);
    res.json({ message: 'Upload cancelled successfully or was already inactive.' });
  } catch (err) {
    logger.error(`[Route /cancel] Error during cancellation for ${uploadId}: ${err.name} - ${err.message}`, err.stack);
    // Generally, client doesn't need to know if server-side abort failed catastrophically,
    // as long as client stops sending. However, if it's a config error, 500 is appropriate.
    let statusCode = err.name === 'NoSuchUpload' ? 200 : 500; // If not found, it's like success for client
    let clientMessage = err.name === 'NoSuchUpload' ? 'Upload already inactive or not found.' : 'Failed to cancel upload on server.';
    if (err.name === 'AccessDenied' || err.name === 'NoSuchBucket') {
        clientMessage = 'Storage configuration error during cancel.';
        statusCode = 500;
    }
    res.status(statusCode).json({ message: clientMessage, details: config.nodeEnv === 'development' ? err.message : undefined });
  }
});

module.exports = { router }; // Only export the router object