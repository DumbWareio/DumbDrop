/**
 * File upload route handlers and batch upload management.
 * Handles file uploads, chunked transfers, and folder creation.
 * Manages upload sessions using persistent metadata for resumability.
 */

const express = require('express');
const router = express.Router();
const { config } = require('../config');
const logger = require('../utils/logger');
const { isDemoMode } = require('../utils/demoMode');
const { storageAdapter } = require('../storage'); // Import the storage adapter
const { isValidBatchId } = require('../utils/fileUtils');
const crypto = require('crypto'); // Keep crypto for demo mode uploadId

// --- Routes ---

// Initialize upload
router.post('/init', async (req, res) => {
  // DEMO MODE CHECK - Bypass persistence if in demo mode
  if (isDemoMode()) {
    const { filename, fileSize } = req.body;
    const uploadId = `demo-${crypto.randomBytes(16).toString('hex')}`;
    logger.info(`[DEMO] Initialized upload for ${filename} (${fileSize} bytes) with ID ${uploadId}`);
    // Simulate zero-byte completion for demo
    if (Number(fileSize) === 0) {
      logger.success(`[DEMO] Completed zero-byte file upload: ${filename}`);
      // sendNotification(filename, 0, config); // In demo, notifications are typically skipped or mocked by demoAdapter
    }
    return res.json({ uploadId });
  }

  const { filename, fileSize } = req.body;
  const clientBatchId = req.headers['x-batch-id'];

  // --- Basic validations ---
  if (!filename) return res.status(400).json({ error: 'Missing filename' });
  if (fileSize === undefined || fileSize === null) return res.status(400).json({ error: 'Missing fileSize' });
  const size = Number(fileSize);
  if (isNaN(size) || size < 0) return res.status(400).json({ error: 'Invalid file size' });
  const maxSizeInBytes = config.maxFileSize;
  if (size > maxSizeInBytes) return res.status(413).json({ error: 'File too large', limit: maxSizeInBytes });

  // Validate clientBatchId if provided
  if (clientBatchId && !isValidBatchId(clientBatchId)) {
    return res.status(400).json({ error: 'Invalid batch ID format' });
  }

  try {
    const { uploadId } = await storageAdapter.initUpload(filename, size, clientBatchId);
    logger.info(`[Route /init] Storage adapter initialized upload: ${uploadId} for ${filename}`);
    res.json({ uploadId });

  } catch (err) {
    logger.error(`[Route /init] Upload initialization failed: ${err.message} ${err.stack}`);
    // Check for specific error types if adapter throws them (e.g., size limit from adapter)
    if (err.message.includes('File too large') || err.status === 413) {
        return res.status(413).json({ error: 'File too large', details: err.message, limit: config.maxFileSize });
    }
    if (err.message.includes('File type not allowed') || err.status === 400) {
        return res.status(400).json({ error: 'File type not allowed', details: err.message });
    }
    return res.status(500).json({ error: 'Failed to initialize upload via adapter', details: err.message });
  }
});

// Upload chunk
router.post('/chunk/:uploadId', express.raw({ 
  limit: config.maxFileSize + (10 * 1024 * 1024), // Generous limit for raw body
  type: 'application/octet-stream' 
}), async (req, res) => {
  // DEMO MODE CHECK
  if (isDemoMode()) {
    const { uploadId } = req.params;
    logger.debug(`[DEMO] Received chunk for ${uploadId}`);
    // Fake progress - requires knowing file size which isn't easily available here in demo
    const demoProgress = Math.min(100, Math.random() * 100); // Placeholder
    return res.json({ bytesReceived: 0, progress: demoProgress });
  }

  const { uploadId } = req.params;
  let chunk = req.body;
  const chunkSize = chunk.length;

  if (!chunkSize) return res.status(400).json({ error: 'Empty chunk received' });

  try {
    // Delegate to storage adapter
    // The adapter's storeChunk should handle partNumber for S3 internally
    const { bytesReceived, progress, completed } = await storageAdapter.storeChunk(uploadId, chunk);
    logger.debug(`[Route /chunk] Stored chunk for ${uploadId}. Progress: ${progress}%, Completed by adapter: ${completed}`);

    if (completed) {
      logger.info(`[Route /chunk] Adapter reported completion for ${uploadId}. Finalizing...`);
      try {
        const finalizationResult = await storageAdapter.completeUpload(uploadId);
        logger.success(`[Route /chunk] Successfully finalized upload ${uploadId}. Final path/key: ${finalizationResult.finalPath}`);
        // The adapter's completeUpload method is responsible for sending notifications and cleaning its metadata.
      } catch (completeErr) {
        logger.error(`[Route /chunk] CRITICAL: Failed to finalize completed upload ${uploadId} after storing chunk: ${completeErr.message} ${completeErr.stack}`);
        // If completeUpload fails, the client might retry the chunk.
        // The adapter's storeChunk should be idempotent or handle this.
        // We still return the progress of the chunk write to the client.
        // The client will likely retry, or the user will see the upload stall at 100% if this was the last chunk.
        // Consider what to return to client here. For now, return chunk progress but log server error.
        // The 'completed' flag from storeChunk might cause client to stop sending if it thinks it's done.
        // If completeUpload fails, maybe the response to client should indicate not fully complete yet?
        // Let's return the original progress. The client will retry if needed.
        return res.status(500).json({ error: 'Chunk processed but finalization failed on server.', details: completeErr.message, currentProgress: progress });
      }
    }
    res.json({ bytesReceived, progress });

  } catch (err) {
    logger.error(`[Route /chunk] Chunk upload failed for ${uploadId}: ${err.message} ${err.stack}`);
    if (err.message.includes('Upload session not found')) {
        return res.status(404).json({ error: 'Upload session not found or already completed', details: err.message });
    }
    // Don't delete adapter's metadata on generic chunk errors, let client retry or adapter's cleanup handle stale entries.
    res.status(500).json({ error: 'Failed to process chunk via adapter', details: err.message });
  }
});

// Cancel upload
router.post('/cancel/:uploadId', async (req, res) => {
  // DEMO MODE CHECK
  if (isDemoMode()) {
    logger.info(`[DEMO] Upload cancelled: ${req.params.uploadId}`);
    return res.json({ message: 'Upload cancelled (Demo)' });
  }

  const { uploadId } = req.params;
  logger.info(`[Route /cancel] Received cancel request for upload: ${uploadId}`);

  try {
    await storageAdapter.abortUpload(uploadId);
    logger.info(`[Route /cancel] Upload ${uploadId} cancelled via storage adapter.`);
    res.json({ message: 'Upload cancelled or already complete' });
  } catch (err) {
    logger.error(`[Route /cancel] Error during upload cancellation for ${uploadId}: ${err.message}`);
    // Adapters should handle "not found" gracefully or throw specific error
    if (err.message.includes('not found')) { // Generic check
        return res.status(404).json({ error: 'Upload not found or already processed', details: err.message });
    }
    res.status(500).json({ error: 'Failed to cancel upload via adapter' });
  }
});

module.exports = {
  router
  // Remove internal metadata/batch cleanup exports as they are adapter-specific now or not used by router
};