/**
 * Local Storage Adapter
 * Handles file operations for storing files on the local filesystem.
 * Implements the storage interface expected by the application routes.
 */

const fs = require('fs').promises;
const fsSync = require('fs'); // For synchronous checks like existsSync
const path = require('path');
const crypto = require('crypto');
const { config } = require('../config');
const logger = require('../utils/logger');
const {
  getUniqueFolderPath,
  sanitizePathPreserveDirs,
  isValidBatchId,
  formatFileSize // Keep formatFileSize accessible if needed by notifications later
} = require('../utils/fileUtils');
const { sendNotification } = require('../services/notifications'); // Needed for completion

const METADATA_DIR = path.join(config.uploadDir, '.metadata');
const UPLOAD_TIMEOUT = 30 * 60 * 1000; // 30 minutes timeout for stale uploads

// --- In-Memory Maps (Session-level optimizations) ---
// Store folder name mappings for batch uploads (avoids FS lookups during session)
// NOTE: This state is specific to this adapter instance and might not scale across multiple server instances.
const folderMappings = new Map();
// Store batch activity timestamps (for cleaning up stale batches/folder mappings)
const batchActivity = new Map();
const BATCH_TIMEOUT = 30 * 60 * 1000; // 30 minutes for batch/folderMapping cleanup

// --- Metadata Helper Functions (Copied and adapted from original upload.js) ---

/**
 * Ensures the metadata directory exists.
 * Should be called once during adapter initialization or before first use.
 */
async function ensureMetadataDirExists() {
    try {
        if (!fsSync.existsSync(METADATA_DIR)) {
            await fs.mkdir(METADATA_DIR, { recursive: true });
            logger.info(`[Local Adapter] Created metadata directory: ${METADATA_DIR}`);
        }
        // Check writability
        await fs.access(METADATA_DIR, fsSync.constants.W_OK);
    } catch (err) {
        logger.error(`[Local Adapter] Metadata directory error (${METADATA_DIR}): ${err.message}`);
        throw new Error(`Failed to access or create metadata directory: ${METADATA_DIR}`);
    }
}

async function readUploadMetadata(uploadId) {
  if (!uploadId || typeof uploadId !== 'string' || uploadId.includes('..')) {
    logger.warn(`[Local Adapter] Attempted to read metadata with invalid uploadId: ${uploadId}`);
    return null;
  }
  const metaFilePath = path.join(METADATA_DIR, `${uploadId}.meta`);
  try {
    const data = await fs.readFile(metaFilePath, 'utf8');
    return JSON.parse(data);
  } catch (err) {
    if (err.code === 'ENOENT') {
      return null; // Metadata file doesn't exist
    }
    logger.error(`[Local Adapter] Error reading metadata for ${uploadId}: ${err.message}`);
    throw err; // Rethrow other errors
  }
}

async function writeUploadMetadata(uploadId, metadata) {
  if (!uploadId || typeof uploadId !== 'string' || uploadId.includes('..')) {
    logger.error(`[Local Adapter] Attempted to write metadata with invalid uploadId: ${uploadId}`);
    return;
  }
  const metaFilePath = path.join(METADATA_DIR, `${uploadId}.meta`);
  metadata.lastActivity = Date.now(); // Update timestamp on every write
  try {
    const tempMetaPath = `${metaFilePath}.${crypto.randomBytes(4).toString('hex')}.tmp`;
    await fs.writeFile(tempMetaPath, JSON.stringify(metadata, null, 2));
    await fs.rename(tempMetaPath, metaFilePath);
  } catch (err) {
    logger.error(`[Local Adapter] Error writing metadata for ${uploadId}: ${err.message}`);
    try { await fs.unlink(tempMetaPath); } catch (unlinkErr) {/* ignore */}
    throw err;
  }
}

async function deleteUploadMetadata(uploadId) {
  if (!uploadId || typeof uploadId !== 'string' || uploadId.includes('..')) {
    logger.warn(`[Local Adapter] Attempted to delete metadata with invalid uploadId: ${uploadId}`);
    return;
  }
  const metaFilePath = path.join(METADATA_DIR, `${uploadId}.meta`);
  try {
    await fs.unlink(metaFilePath);
    logger.debug(`[Local Adapter] Deleted metadata file: ${uploadId}.meta`);
  } catch (err) {
    if (err.code !== 'ENOENT') { // Ignore if already deleted
      logger.error(`[Local Adapter] Error deleting metadata file ${uploadId}.meta: ${err.message}`);
    }
  }
}

// --- Batch Cleanup (In-memory session state cleanup) ---
// This logic remains relevant for the in-memory folderMappings if used across batches.
let batchCleanupInterval;
function startBatchCleanup() {
  if (batchCleanupInterval) clearInterval(batchCleanupInterval);
  batchCleanupInterval = setInterval(() => {
    const now = Date.now();
    logger.info(`[Local Adapter] Running batch session cleanup, checking ${batchActivity.size} active sessions`);
    let cleanedCount = 0;
    for (const [batchId, lastActivity] of batchActivity.entries()) {
      if (now - lastActivity >= BATCH_TIMEOUT) {
        logger.info(`[Local Adapter] Cleaning up inactive batch session: ${batchId}`);
        batchActivity.delete(batchId);
        // Clean up associated folder mappings
        for (const key of folderMappings.keys()) {
          if (key.endsWith(`-${batchId}`)) {
            folderMappings.delete(key);
          }
        }
        cleanedCount++;
      }
    }
    if (cleanedCount > 0) logger.info(`[Local Adapter] Cleaned up ${cleanedCount} inactive batch sessions.`);
  }, 5 * 60 * 1000); // Check every 5 minutes
  batchCleanupInterval.unref();
}
// Ensure metadata dir exists before starting cleanup or other ops
ensureMetadataDirExists().then(() => {
    logger.info('[Local Adapter] Initialized.');
    // Start batch cleanup only after ensuring dir exists
    if (!process.env.DISABLE_BATCH_CLEANUP) {
      startBatchCleanup();
    }
}).catch(err => {
    logger.error(`[Local Adapter] Initialization failed: ${err.message}`);
    // Potentially exit or prevent server start if metadata dir is critical
    process.exit(1);
});


// --- Interface Implementation ---

/**
 * Initializes an upload session.
 * @param {string} filename - Original filename/path from client.
 * @param {number} fileSize - Total size of the file.
 * @param {string} clientBatchId - Optional batch ID from client.
 * @returns {Promise<{uploadId: string}>} Object containing the application's upload ID.
 */
async function initUpload(filename, fileSize, clientBatchId) {
  await ensureMetadataDirExists(); // Ensure it exists before proceeding

  const size = Number(fileSize);
  // Basic validations moved to route handler, assume valid inputs here

  const batchId = clientBatchId || `${Date.now()}-${crypto.randomBytes(4).toString('hex').substring(0, 9)}`;
  if (clientBatchId && !isValidBatchId(batchId)) {
      throw new Error('Invalid batch ID format'); // Throw error for route handler
  }
  batchActivity.set(batchId, Date.now()); // Track batch session activity

  // --- Path handling and Sanitization ---
  const sanitizedFilename = sanitizePathPreserveDirs(filename);
  const safeFilename = path.normalize(sanitizedFilename)
    .replace(/^(\.\.(\/|\\|$))+/, '')
    .replace(/\\/g, '/')
    .replace(/^\/+/, '');
  logger.info(`[Local Adapter] Init request for: ${safeFilename}`);

  // --- Determine Paths & Handle Folders ---
  const uploadId = crypto.randomBytes(16).toString('hex');
  let finalFilePath = path.resolve(config.uploadDir, safeFilename); // Use resolve for absolute path
  const pathParts = safeFilename.split('/').filter(Boolean);

  if (pathParts.length > 1) {
    const originalFolderName = pathParts[0];
    const folderMapKey = `${originalFolderName}-${batchId}`;
    let newFolderName = folderMappings.get(folderMapKey);
    const relativeFolderPath = newFolderName || originalFolderName; // Folder name relative to uploadDir

    if (!newFolderName) {
        const baseFolderPath = path.resolve(config.uploadDir, relativeFolderPath);
        await fs.mkdir(path.dirname(baseFolderPath), { recursive: true }); // Ensure parent of potential new folder exists
        try {
            await fs.mkdir(baseFolderPath, { recursive: false }); // Try creating the original/mapped name
            newFolderName = originalFolderName; // Success, use original
        } catch (err) {
            if (err.code === 'EEXIST') {
                // Folder exists, generate a unique name for this batch
                const uniqueFolderPath = await getUniqueFolderPath(baseFolderPath); // Pass absolute path
                newFolderName = path.basename(uniqueFolderPath); // Get only the unique folder name part
                logger.info(`[Local Adapter] Folder "${originalFolderName}" exists or conflict, using unique "${newFolderName}" for batch ${batchId}`);
                // No need to mkdir again, getUniqueFolderPath created it.
            } else {
                logger.error(`[Local Adapter] Error creating directory ${baseFolderPath}: ${err.message}`);
                throw err; // Re-throw other errors
            }
        }
        folderMappings.set(folderMapKey, newFolderName); // Store mapping for this batch
    }
    // Reconstruct the final path using the potentially unique folder name
    pathParts[0] = newFolderName;
    finalFilePath = path.resolve(config.uploadDir, ...pathParts);
    // Ensure the immediate parent directory for the file exists
    await fs.mkdir(path.dirname(finalFilePath), { recursive: true });
  } else {
    // Ensure base upload dir exists (already done by ensureLocalUploadDirExists, but safe to repeat)
    await fs.mkdir(config.uploadDir, { recursive: true });
  }

  // --- Check Final Path Collision & Get Unique Name if Needed ---
  // Check if the *final* destination exists (not the partial)
  let checkPath = finalFilePath;
  let counter = 1;
  while (fsSync.existsSync(checkPath)) {
    logger.warn(`[Local Adapter] Final destination file already exists: ${checkPath}. Generating unique name.`);
    const dir = path.dirname(finalFilePath);
    const ext = path.extname(finalFilePath);
    const baseName = path.basename(finalFilePath, ext);
    checkPath = path.resolve(dir, `${baseName} (${counter})${ext}`); // Use resolve
    counter++;
  }
  if (checkPath !== finalFilePath) {
    logger.info(`[Local Adapter] Using unique final path: ${checkPath}`);
    finalFilePath = checkPath;
    // If path changed, ensure directory exists again (might be needed if baseName contained '/')
    await fs.mkdir(path.dirname(finalFilePath), { recursive: true });
  }

  const partialFilePath = finalFilePath + '.partial';

  // --- Create and Persist Metadata ---
  const metadata = {
    uploadId,
    originalFilename: safeFilename, // Store the path as received by client
    filePath: finalFilePath,       // The final, possibly unique, path
    partialFilePath,
    fileSize: size,
    bytesReceived: 0,
    batchId,
    createdAt: Date.now(),
    lastActivity: Date.now()
  };

  await writeUploadMetadata(uploadId, metadata);
  logger.info(`[Local Adapter] Initialized upload: ${uploadId} for ${safeFilename} -> ${finalFilePath}`);

  // --- Handle Zero-Byte Files ---
  if (size === 0) {
    try {
      await fs.writeFile(finalFilePath, ''); // Create the empty file directly
      logger.success(`[Local Adapter] Completed zero-byte file: ${metadata.originalFilename} as ${finalFilePath}`);
      await deleteUploadMetadata(uploadId); // Clean up metadata
      sendNotification(metadata.originalFilename, 0, config); // Send notification
    } catch (writeErr) {
      logger.error(`[Local Adapter] Failed to create zero-byte file ${finalFilePath}: ${writeErr.message}`);
      await deleteUploadMetadata(uploadId).catch(() => {}); // Attempt cleanup
      throw writeErr; // Let the route handler catch it
    }
  }

  return { uploadId };
}

/**
 * Stores a chunk of data for a given uploadId.
 * @param {string} uploadId - The application's upload ID.
 * @param {Buffer} chunk - The data chunk to store.
 * @returns {Promise<{bytesReceived: number, progress: number, completed: boolean}>} Upload status.
 */
async function storeChunk(uploadId, chunk) {
  const chunkSize = chunk.length;
  if (!chunkSize) {
      throw new Error('Empty chunk received');
  }

  const metadata = await readUploadMetadata(uploadId);

  if (!metadata) {
    // Maybe the upload completed *just* before this chunk arrived? Check final file.
    // This is hard to do reliably without knowing the final path from metadata.
    // Return a specific error or status code might be better.
    logger.warn(`[Local Adapter] Metadata not found for chunk: ${uploadId}. Upload might be complete or cancelled.`);
    throw new Error('Upload session not found or already completed'); // Let route handler return 404
  }

  // Update batch activity
  if (metadata.batchId && isValidBatchId(metadata.batchId)) {
    batchActivity.set(metadata.batchId, Date.now());
  }

  // --- Sanity Checks ---
  if (metadata.bytesReceived >= metadata.fileSize) {
    logger.warn(`[Local Adapter] Received chunk for already completed upload ${uploadId}. Finalizing again.`);
    // Attempt to finalize just in case, then return completed status
    await completeUpload(uploadId); // This handles metadata deletion etc.
    return { bytesReceived: metadata.fileSize, progress: 100, completed: true };
  }

  let chunkToWrite = chunk;
  let actualChunkSize = chunkSize;

  // Prevent writing beyond expected file size
  if (metadata.bytesReceived + chunkSize > metadata.fileSize) {
    logger.warn(`[Local Adapter] Chunk for ${uploadId} exceeds expected size. Truncating.`);
    const bytesToWrite = metadata.fileSize - metadata.bytesReceived;
    chunkToWrite = chunk.slice(0, bytesToWrite);
    actualChunkSize = chunkToWrite.length;
    if (actualChunkSize <= 0) {
        logger.info(`[Local Adapter] Upload ${uploadId} already has expected bytes. Skipping write.`);
        metadata.bytesReceived = metadata.fileSize; // Correct state for completion check
    }
  }

  // --- Write Chunk (Append Mode) ---
  if (actualChunkSize > 0) {
      try {
          await fs.appendFile(metadata.partialFilePath, chunkToWrite);
          metadata.bytesReceived += actualChunkSize;
      } catch (writeErr) {
          logger.error(`[Local Adapter] Failed to write chunk for ${uploadId} to ${metadata.partialFilePath}: ${writeErr.message}`);
          throw new Error(`Failed to write chunk for ${uploadId}: ${writeErr.code}`); // Propagate error
      }
  }

  // --- Update State ---
  const progress = metadata.fileSize === 0 ? 100 :
    Math.min(Math.round((metadata.bytesReceived / metadata.fileSize) * 100), 100);

  logger.debug(`[Local Adapter] Chunk written for ${uploadId}: ${metadata.bytesReceived}/${metadata.fileSize} (${progress}%)`);

  // Persist updated metadata *before* final completion check
  await writeUploadMetadata(uploadId, metadata);

  // --- Check for Completion ---
  const completed = metadata.bytesReceived >= metadata.fileSize;
  if (completed) {
    // Don't call completeUpload here, let the route handler do it
    // after sending the final progress response back to the client.
    logger.info(`[Local Adapter] Upload ${uploadId} ready for completion (${metadata.bytesReceived} bytes).`);
  }

  return { bytesReceived: metadata.bytesReceived, progress, completed };
}

/**
 * Finalizes a completed upload.
 * @param {string} uploadId - The application's upload ID.
 * @returns {Promise<{filename: string, size: number}>} Details of the completed file.
 */
async function completeUpload(uploadId) {
  const metadata = await readUploadMetadata(uploadId);
  if (!metadata) {
    // Might have been completed by a concurrent request. Check if final file exists.
    // This is still tricky without the metadata. Log a warning.
    logger.warn(`[Local Adapter] completeUpload called for ${uploadId}, but metadata is missing. Assuming already completed.`);
    // We don't know the filename or size here, return minimal success or throw?
    // Let's throw, as the calling route expects metadata info.
    throw new Error('Upload completion failed: Metadata not found');
  }

  // Ensure we have received all bytes (redundant check, but safe)
  if (metadata.bytesReceived < metadata.fileSize) {
       logger.error(`[Local Adapter] Attempted to complete upload ${uploadId} prematurely. Received ${metadata.bytesReceived}/${metadata.fileSize} bytes.`);
       throw new Error('Cannot complete upload: Not all bytes received.');
  }

  try {
    // Ensure partial file exists before rename
    await fs.access(metadata.partialFilePath);
    await fs.rename(metadata.partialFilePath, metadata.filePath);
    logger.success(`[Local Adapter] Finalized: ${metadata.originalFilename} as ${metadata.filePath} (${metadata.fileSize} bytes)`);

    // Clean up metadata AFTER successful rename
    await deleteUploadMetadata(uploadId);

    // Send notification
    sendNotification(metadata.originalFilename, metadata.fileSize, config);

    return { filename: metadata.originalFilename, size: metadata.fileSize, finalPath: metadata.filePath };

  } catch (renameErr) {
    if (renameErr.code === 'ENOENT') {
      // Partial file missing. Maybe completed by another request? Check final file.
      try {
        await fs.access(metadata.filePath);
        logger.warn(`[Local Adapter] Partial file ${metadata.partialFilePath} missing for ${uploadId}, but final file ${metadata.filePath} exists. Assuming already finalized.`);
        await deleteUploadMetadata(uploadId).catch(()=>{}); // Cleanup metadata anyway
        return { filename: metadata.originalFilename, size: metadata.fileSize, finalPath: metadata.filePath };
      } catch (finalAccessErr) {
         logger.error(`[Local Adapter] CRITICAL: Partial file ${metadata.partialFilePath} missing and final file ${metadata.filePath} not found during completion of ${uploadId}.`);
         await deleteUploadMetadata(uploadId).catch(()=>{}); // Cleanup metadata to prevent retries
         throw new Error(`Completion failed: Partial file missing and final file not found.`);
      }
    } else {
      logger.error(`[Local Adapter] CRITICAL: Failed to rename ${metadata.partialFilePath} to ${metadata.filePath}: ${renameErr.message}`);
      // Keep metadata and partial file for potential manual recovery.
      throw renameErr; // Propagate the error
    }
  }
}

/**
 * Aborts an ongoing upload.
 * @param {string} uploadId - The application's upload ID.
 * @returns {Promise<void>}
 */
async function abortUpload(uploadId) {
  const metadata = await readUploadMetadata(uploadId);
  if (!metadata) {
    logger.warn(`[Local Adapter] Abort request for non-existent or completed upload: ${uploadId}`);
    return; // Nothing to abort
  }

  // Delete partial file first
  try {
    await fs.unlink(metadata.partialFilePath);
    logger.info(`[Local Adapter] Deleted partial file on cancellation: ${metadata.partialFilePath}`);
  } catch (unlinkErr) {
    if (unlinkErr.code !== 'ENOENT') { // Ignore if already gone
      logger.error(`[Local Adapter] Failed to delete partial file ${metadata.partialFilePath} on cancel: ${unlinkErr.message}`);
      // Continue to delete metadata anyway
    }
  }

  // Then delete metadata file
  await deleteUploadMetadata(uploadId);
  logger.info(`[Local Adapter] Upload cancelled and cleaned up: ${uploadId} (${metadata.originalFilename})`);
}

/**
 * Lists files in the upload directory.
 * @returns {Promise<Array<{filename: string, size: number, formattedSize: string, uploadDate: Date}>>} List of files.
 */
async function listFiles() {
  let entries = [];
  try {
      entries = await fs.readdir(config.uploadDir, { withFileTypes: true });
  } catch (err) {
      if (err.code === 'ENOENT') {
          logger.warn('[Local Adapter] Upload directory does not exist for listing.');
          return []; // Return empty list if dir doesn't exist
      }
      logger.error(`[Local Adapter] Failed to read upload directory: ${err.message}`);
      throw err; // Re-throw other errors
  }

  const fileDetails = [];
  for (const entry of entries) {
    // Skip directories and the special metadata directory/files within it
    if (!entry.isFile() || entry.name === '.metadata' || entry.name.endsWith('.partial') || entry.name.endsWith('.meta') || entry.name.endsWith('.tmp')) {
      continue;
    }

    try {
      const filePath = path.join(config.uploadDir, entry.name);
      const stats = await fs.stat(filePath);
      fileDetails.push({
        filename: entry.name, // Use the actual filename on disk
        size: stats.size,
        formattedSize: formatFileSize(stats.size), // Use fileUtils helper
        uploadDate: stats.mtime // Use modification time as upload date
      });
    } catch (statErr) {
      // Handle case where file might be deleted between readdir and stat
      if (statErr.code !== 'ENOENT') {
        logger.error(`[Local Adapter] Failed to get stats for file ${entry.name}: ${statErr.message}`);
      }
      // Skip this file if stat fails
    }
  }

  // Sort by date, newest first
  fileDetails.sort((a, b) => b.uploadDate.getTime() - a.uploadDate.getTime());

  return fileDetails;
}

/**
 * Gets information needed to download a file.
 * For local storage, this is the file path.
 * @param {string} filename - The name of the file to download.
 * @returns {Promise<{type: string, value: string}>} Object indicating type ('path') and value (the full file path).
 */
async function getDownloadUrlOrStream(filename) {
  // IMPORTANT: Sanitize filename input to prevent directory traversal
  const safeBaseName = path.basename(filename);
  if (safeBaseName !== filename || filename.includes('..')) {
      logger.error(`[Local Adapter] Invalid filename detected for download: ${filename}`);
      throw new Error('Invalid filename');
  }

  const filePath = path.resolve(config.uploadDir, safeBaseName); // Use resolve for security

  try {
    await fs.access(filePath, fsSync.constants.R_OK); // Check existence and readability
    return { type: 'path', value: filePath };
  } catch (err) {
    if (err.code === 'ENOENT') {
      logger.warn(`[Local Adapter] Download request for non-existent file: ${filePath}`);
      throw new Error('File not found'); // Specific error for 404 handling
    } else if (err.code === 'EACCES') {
         logger.error(`[Local Adapter] Permission denied trying to access file for download: ${filePath}`);
         throw new Error('Permission denied');
    } else {
      logger.error(`[Local Adapter] Error accessing file for download ${filePath}: ${err.message}`);
      throw err; // Re-throw other errors
    }
  }
}

/**
 * Deletes a file from the local storage.
 * @param {string} filename - The name of the file to delete.
 * @returns {Promise<void>}
 */
async function deleteFile(filename) {
  // IMPORTANT: Sanitize filename input
  const safeBaseName = path.basename(filename);
   if (safeBaseName !== filename || filename.includes('..')) {
      logger.error(`[Local Adapter] Invalid filename detected for delete: ${filename}`);
      throw new Error('Invalid filename');
  }

  const filePath = path.resolve(config.uploadDir, safeBaseName);

  try {
    await fs.unlink(filePath);
    logger.info(`[Local Adapter] Deleted file: ${filePath}`);
  } catch (err) {
    if (err.code === 'ENOENT') {
      logger.warn(`[Local Adapter] Delete request for non-existent file: ${filePath}`);
      throw new Error('File not found'); // Specific error for 404
    } else {
      logger.error(`[Local Adapter] Failed to delete file ${filePath}: ${err.message}`);
      throw err; // Re-throw other errors
    }
  }
}

/**
 * Cleans up stale resources (incomplete uploads based on metadata).
 * @returns {Promise<void>}
 */
async function cleanupStale() {
  logger.info('[Local Adapter] Running cleanup for stale metadata/partial uploads...');
  let cleanedCount = 0;
  let checkedCount = 0;

  try {
    // Ensure metadata directory exists before trying to read it
    await ensureMetadataDirExists(); // Re-check just in case

    const files = await fs.readdir(METADATA_DIR);
    const now = Date.now();

    for (const file of files) {
      if (file.endsWith('.meta')) {
        checkedCount++;
        const uploadId = file.replace('.meta', '');
        const metaFilePath = path.join(METADATA_DIR, file);
        let metadata;

        try {
          const data = await fs.readFile(metaFilePath, 'utf8');
          metadata = JSON.parse(data);

          // Check inactivity
          if (now - (metadata.lastActivity || metadata.createdAt || 0) > UPLOAD_TIMEOUT) {
            logger.warn(`[Local Adapter] Found stale metadata: ${file}. Last activity: ${new Date(metadata.lastActivity || metadata.createdAt)}`);

            // Attempt to delete partial file
            if (metadata.partialFilePath) {
              try {
                await fs.unlink(metadata.partialFilePath);
                logger.info(`[Local Adapter] Deleted stale partial file: ${metadata.partialFilePath}`);
              } catch (unlinkPartialErr) {
                if (unlinkPartialErr.code !== 'ENOENT') {
                  logger.error(`[Local Adapter] Failed to delete stale partial ${metadata.partialFilePath}: ${unlinkPartialErr.message}`);
                }
              }
            }

            // Attempt to delete metadata file
            await deleteUploadMetadata(uploadId); // Use helper
            cleanedCount++;

          }
        } catch (readErr) {
          logger.error(`[Local Adapter] Error reading/parsing ${metaFilePath} during cleanup: ${readErr.message}. Skipping.`);
          // Optionally attempt to delete the corrupt meta file?
           await fs.unlink(metaFilePath).catch(()=>{ logger.warn(`[Local Adapter] Failed to delete potentially corrupt metadata file: ${metaFilePath}`) });
        }
      } else if (file.endsWith('.tmp')) {
        // Clean up potential leftover temp metadata files
         const tempMetaPath = path.join(METADATA_DIR, file);
         try {
             const stats = await fs.stat(tempMetaPath);
             // Use a shorter timeout for temp files? e.g., UPLOAD_TIMEOUT / 2
             if (now - stats.mtime.getTime() > UPLOAD_TIMEOUT) {
                 logger.warn(`[Local Adapter] Deleting stale temporary metadata file: ${file}`);
                 await fs.unlink(tempMetaPath);
             }
         } catch (statErr) {
              if (statErr.code !== 'ENOENT') {
                 logger.error(`[Local Adapter] Error checking temp metadata file ${tempMetaPath}: ${statErr.message}`);
              }
         }
      }
    }

    if (checkedCount > 0 || cleanedCount > 0) {
      logger.info(`[Local Adapter] Metadata cleanup finished. Checked: ${checkedCount}, Cleaned stale: ${cleanedCount}.`);
    }

  } catch (err) {
    if (err.code === 'ENOENT' && err.path === METADATA_DIR) {
      // This case should be handled by ensureMetadataDirExists, but log just in case
       logger.warn('[Local Adapter] Metadata directory not found during cleanup scan.');
    } else {
      logger.error(`[Local Adapter] Error during metadata cleanup scan: ${err.message}`);
    }
  }

  // Note: Empty folder cleanup is handled by the main cleanup utility for now.
  // If needed, the logic from utils/cleanup.js -> cleanupEmptyFolders could be moved here.
}

module.exports = {
  initUpload,
  storeChunk,
  completeUpload,
  abortUpload,
  listFiles,
  getDownloadUrlOrStream,
  deleteFile,
  cleanupStale
};