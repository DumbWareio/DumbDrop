/**
 * S3 Storage Adapter
 * Handles file operations for storing files on AWS S3 or S3-compatible services.
 * Implements the storage interface expected by the application routes.
 * Uses local files in '.metadata' directory to track multipart upload progress.
 */

const {
    S3Client,
    CreateMultipartUploadCommand,
    UploadPartCommand,
    CompleteMultipartUploadCommand,
    AbortMultipartUploadCommand,
    ListObjectsV2Command,
    GetObjectCommand,
    DeleteObjectCommand,
    PutObjectCommand // For zero-byte files
  } = require('@aws-sdk/client-s3');
  const { getSignedUrl } = require("@aws-sdk/s3-request-presigner");
  const fs = require('fs').promises;
  const fsSync = require('fs'); // For synchronous checks
  const path = require('path');
  const crypto = require('crypto');
  const { config } = require('../config');
  const logger = require('../utils/logger');
  const {
    sanitizePathPreserveDirs,
    isValidBatchId,
    formatFileSize // Keep for potential future use or consistency
  } = require('../utils/fileUtils');
  const { sendNotification } = require('../services/notifications'); // Needed for completion
  
  // --- Constants ---
  const METADATA_DIR = path.join(config.uploadDir, '.metadata'); // Use local dir for metadata state
  const UPLOAD_TIMEOUT = 30 * 60 * 1000; // 30 minutes timeout for stale *local* metadata cleanup
  
  // --- S3 Client Initialization ---
  let s3Client;
  try {
      const s3ClientConfig = {
          region: config.s3Region,
          credentials: {
              accessKeyId: config.s3AccessKeyId,
              secretAccessKey: config.s3SecretAccessKey,
          },
          ...(config.s3EndpointUrl && { endpoint: config.s3EndpointUrl }),
          ...(config.s3ForcePathStyle && { forcePathStyle: true }),
      };
  
      if (s3ClientConfig.endpoint) {
          logger.info(`[S3 Adapter] Configuring S3 client for endpoint: ${s3ClientConfig.endpoint}`);
      }
      if (s3ClientConfig.forcePathStyle) {
          logger.info(`[S3 Adapter] Configuring S3 client with forcePathStyle: true`);
      }
  
      s3Client = new S3Client(s3ClientConfig);
      logger.success('[S3 Adapter] S3 Client configured successfully.');
  
  } catch (error) {
       logger.error(`[S3 Adapter] Failed to configure S3 client: ${error.message}`);
       // This is critical, throw an error to prevent the adapter from being used incorrectly
       throw new Error('S3 Client configuration failed. Check S3 environment variables.');
  }
  
  // --- Metadata Helper Functions (Adapted for S3, store state locally) ---
  
  async function ensureMetadataDirExists() {
      // Reuse logic from local adapter - S3 adapter still needs local dir for state
      try {
          if (!fsSync.existsSync(METADATA_DIR)) {
              await fs.mkdir(METADATA_DIR, { recursive: true });
              logger.info(`[S3 Adapter] Created local metadata directory: ${METADATA_DIR}`);
          }
          await fs.access(METADATA_DIR, fsSync.constants.W_OK);
      } catch (err) {
          logger.error(`[S3 Adapter] Local metadata directory error (${METADATA_DIR}): ${err.message}`);
          throw new Error(`Failed to access or create local metadata directory for S3 adapter state: ${METADATA_DIR}`);
      }
  }
  
  // Read/Write/Delete functions are identical to localAdapter as they manage local state files
  async function readUploadMetadata(uploadId) {
    if (!uploadId || typeof uploadId !== 'string' || uploadId.includes('..')) {
      logger.warn(`[S3 Adapter] Attempted to read metadata with invalid uploadId: ${uploadId}`);
      return null;
    }
    const metaFilePath = path.join(METADATA_DIR, `${uploadId}.meta`);
    try {
      const data = await fs.readFile(metaFilePath, 'utf8');
      // Ensure 'parts' is always an array on read
      const metadata = JSON.parse(data);
      metadata.parts = metadata.parts || [];
      return metadata;
    } catch (err) {
      if (err.code === 'ENOENT') { return null; }
      logger.error(`[S3 Adapter] Error reading metadata for ${uploadId}: ${err.message}`);
      throw err;
    }
  }
  
  async function writeUploadMetadata(uploadId, metadata) {
    if (!uploadId || typeof uploadId !== 'string' || uploadId.includes('..')) {
      logger.error(`[S3 Adapter] Attempted to write metadata with invalid uploadId: ${uploadId}`);
      return;
    }
    const metaFilePath = path.join(METADATA_DIR, `${uploadId}.meta`);
    metadata.lastActivity = Date.now();
    metadata.parts = metadata.parts || []; // Ensure parts array exists
    try {
      const tempMetaPath = `${metaFilePath}.${crypto.randomBytes(4).toString('hex')}.tmp`;
      await fs.writeFile(tempMetaPath, JSON.stringify(metadata, null, 2));
      await fs.rename(tempMetaPath, metaFilePath);
    } catch (err) {
      logger.error(`[S3 Adapter] Error writing metadata for ${uploadId}: ${err.message}`);
      try { await fs.unlink(tempMetaPath); } catch (unlinkErr) {/* ignore */}
      throw err;
    }
  }
  
  async function deleteUploadMetadata(uploadId) {
    if (!uploadId || typeof uploadId !== 'string' || uploadId.includes('..')) {
      logger.warn(`[S3 Adapter] Attempted to delete metadata with invalid uploadId: ${uploadId}`);
      return;
    }
    const metaFilePath = path.join(METADATA_DIR, `${uploadId}.meta`);
    try {
      await fs.unlink(metaFilePath);
      logger.debug(`[S3 Adapter] Deleted metadata file: ${uploadId}.meta`);
    } catch (err) {
      if (err.code !== 'ENOENT') {
        logger.error(`[S3 Adapter] Error deleting metadata file ${uploadId}.meta: ${err.message}`);
      }
    }
  }
  
  // Ensure metadata dir exists on initialization
  ensureMetadataDirExists().catch(err => {
      logger.error(`[S3 Adapter] Initialization failed: ${err.message}`);
      process.exit(1); // Exit if we can't manage metadata state
  });
  
  
  // --- Interface Implementation ---
  
  /**
   * Initializes an S3 multipart upload session (or direct put for zero-byte).
   * @param {string} filename - Original filename/path from client.
   * @param {number} fileSize - Total size of the file.
   * @param {string} clientBatchId - Optional batch ID from client.
   * @returns {Promise<{uploadId: string}>} Object containing the application's upload ID.
   */
  async function initUpload(filename, fileSize, clientBatchId) {
    await ensureMetadataDirExists(); // Re-check before operation
  
    const size = Number(fileSize);
    const appUploadId = crypto.randomBytes(16).toString('hex'); // Our internal ID
  
    // --- Path handling and Sanitization for S3 Key ---
    const sanitizedFilename = sanitizePathPreserveDirs(filename);
    // S3 keys should not start with /
    const s3Key = path.normalize(sanitizedFilename)
      .replace(/^(\.\.(\/|\\|$))+/, '')
      .replace(/\\/g, '/')
      .replace(/^\/+/, '');
  
    logger.info(`[S3 Adapter] Init request for S3 Key: ${s3Key}`);
  
    // --- Handle Zero-Byte Files ---
    if (size === 0) {
      try {
        const putCommand = new PutObjectCommand({
          Bucket: config.s3BucketName,
          Key: s3Key,
          Body: '', // Empty body
          ContentLength: 0
        });
        await s3Client.send(putCommand);
        logger.success(`[S3 Adapter] Completed zero-byte file upload directly: ${s3Key}`);
        // No metadata needed for zero-byte files as they are completed atomically
        sendNotification(filename, 0, config); // Send notification (use original filename)
        // Return an uploadId that won't conflict or be processable by chunk/complete
        return { uploadId: `zero-byte-${appUploadId}` }; // Or maybe return null/special status?
                                                         // Returning a unique ID might be safer for client state.
      } catch (putErr) {
        logger.error(`[S3 Adapter] Failed to put zero-byte object ${s3Key}: ${putErr.message}`);
        throw putErr; // Let the route handler deal with it
      }
    }
  
    // --- Initiate Multipart Upload for Non-Zero Files ---
    try {
      const createCommand = new CreateMultipartUploadCommand({
        Bucket: config.s3BucketName,
        Key: s3Key,
        // TODO: Consider adding ContentType if available/reliable: metadata.contentType
        // TODO: Consider adding Metadata: { 'original-filename': filename } ?
      });
  
      const response = await s3Client.send(createCommand);
      const s3UploadId = response.UploadId;
  
      if (!s3UploadId) {
          throw new Error('S3 did not return an UploadId');
      }
  
      logger.info(`[S3 Adapter] Initiated multipart upload for ${s3Key} (S3 UploadId: ${s3UploadId})`);
  
      // --- Create and Persist Local Metadata ---
      const batchId = clientBatchId || `${Date.now()}-${crypto.randomBytes(4).toString('hex').substring(0, 9)}`;
      const metadata = {
        appUploadId: appUploadId, // Store our ID
        s3UploadId: s3UploadId,
        s3Key: s3Key,
        originalFilename: filename, // Keep original for notifications etc.
        fileSize: size,
        bytesReceived: 0, // Track approximate bytes locally
        parts: [], // Array to store { PartNumber, ETag }
        batchId,
        createdAt: Date.now(),
        lastActivity: Date.now()
      };
  
      await writeUploadMetadata(appUploadId, metadata); // Write metadata keyed by our appUploadId
  
      return { uploadId: appUploadId }; // Return OUR internal upload ID to the client
  
    } catch (err) {
      logger.error(`[S3 Adapter] Failed to initiate multipart upload for ${s3Key}: ${err.message}`);
      // TODO: Map specific S3 errors (e.g., NoSuchBucket, AccessDenied) to better client messages
      throw err;
    }
  }
  
  /**
   * Uploads a chunk as a part to S3.
   * @param {string} appUploadId - The application's upload ID.
   * @param {Buffer} chunk - The data chunk to store.
   * @param {number} partNumber - The sequential number of this part (starting from 1).
   * @returns {Promise<{bytesReceived: number, progress: number, completed: boolean}>} Upload status.
   */
  async function storeChunk(appUploadId, chunk, partNumber) {
    const chunkSize = chunk.length;
    if (!chunkSize) throw new Error('Empty chunk received');
    if (partNumber < 1) throw new Error('PartNumber must be 1 or greater');
  
    const metadata = await readUploadMetadata(appUploadId);
    if (!metadata || !metadata.s3UploadId) { // Check for s3UploadId presence
      logger.warn(`[S3 Adapter] Metadata or S3 UploadId not found for chunk: ${appUploadId}. Upload might be complete, cancelled, or zero-byte.`);
      throw new Error('Upload session not found or already completed');
    }
  
    // --- Sanity Check ---
    // S3 handles duplicate part uploads gracefully (last one wins), so less critical than local append.
    // We still track bytesReceived locally for progress approximation.
    if (metadata.bytesReceived >= metadata.fileSize && metadata.fileSize > 0) {
       logger.warn(`[S3 Adapter] Received chunk for already completed upload ${appUploadId}. Ignoring.`);
       // Can't really finalize again easily without full parts list. Indicate completion based on local state.
       const progress = metadata.fileSize > 0 ? 100 : 0;
       return { bytesReceived: metadata.bytesReceived, progress, completed: true };
    }
  
  
    try {
      const uploadPartCommand = new UploadPartCommand({
        Bucket: config.s3BucketName,
        Key: metadata.s3Key,
        UploadId: metadata.s3UploadId,
        Body: chunk,
        PartNumber: partNumber,
        ContentLength: chunkSize // Required for UploadPart
      });
  
      const response = await s3Client.send(uploadPartCommand);
      const etag = response.ETag;
  
      if (!etag) {
          throw new Error(`S3 did not return an ETag for PartNumber ${partNumber}`);
      }
  
      // --- Update Local Metadata ---
      // Ensure parts are stored correctly
      metadata.parts = metadata.parts || [];
      metadata.parts.push({ PartNumber: partNumber, ETag: etag });
      // Sort parts just in case uploads happen out of order client-side (though unlikely with current client)
      metadata.parts.sort((a, b) => a.PartNumber - b.PartNumber);
  
      // Update approximate bytes received
      metadata.bytesReceived = (metadata.bytesReceived || 0) + chunkSize;
      // Cap bytesReceived at fileSize for progress calculation
      metadata.bytesReceived = Math.min(metadata.bytesReceived, metadata.fileSize);
  
      await writeUploadMetadata(appUploadId, metadata);
  
      // --- Calculate Progress ---
      const progress = metadata.fileSize === 0 ? 100 :
          Math.min(Math.round((metadata.bytesReceived / metadata.fileSize) * 100), 100);
  
      logger.debug(`[S3 Adapter] Part ${partNumber} uploaded for ${appUploadId} (ETag: ${etag}). Progress: ~${progress}%`);
  
      // Check for completion potential based on local byte tracking
      const completed = metadata.bytesReceived >= metadata.fileSize;
       if (completed) {
         logger.info(`[S3 Adapter] Upload ${appUploadId} potentially complete based on bytes received.`);
       }
  
      return { bytesReceived: metadata.bytesReceived, progress, completed };
  
    } catch (err) {
      logger.error(`[S3 Adapter] Failed to upload part ${partNumber} for ${appUploadId} (Key: ${metadata.s3Key}): ${err.message}`);
      // TODO: Map specific S3 errors (InvalidPart, SlowDown, etc.)
      throw err;
    }
  }
  
  /**
   * Finalizes a completed S3 multipart upload.
   * @param {string} appUploadId - The application's upload ID.
   * @returns {Promise<{filename: string, size: number, finalPath: string}>} Details of the completed file (finalPath is S3 Key).
   */
  async function completeUpload(appUploadId) {
    const metadata = await readUploadMetadata(appUploadId);
    if (!metadata || !metadata.s3UploadId || !metadata.parts || metadata.parts.length === 0) {
      logger.warn(`[S3 Adapter] completeUpload called for ${appUploadId}, but metadata, S3 UploadId, or parts list is missing/empty. Assuming already completed or invalid state.`);
      // Check if object exists as a fallback? Risky.
      throw new Error('Upload completion failed: Required metadata or parts list not found');
    }
  
     // Basic check if enough bytes were tracked locally (approximate check)
     if (metadata.bytesReceived < metadata.fileSize) {
       logger.warn(`[S3 Adapter] Attempting to complete upload ${appUploadId} but locally tracked bytes (${metadata.bytesReceived}) are less than expected size (${metadata.fileSize}). Proceeding anyway.`);
     }
  
    try {
      const completeCommand = new CompleteMultipartUploadCommand({
        Bucket: config.s3BucketName,
        Key: metadata.s3Key,
        UploadId: metadata.s3UploadId,
        MultipartUpload: {
          Parts: metadata.parts // Use the collected parts { PartNumber, ETag }
        },
      });
  
      const response = await s3Client.send(completeCommand);
      // Example response: { ETag: '"..."', Location: '...', Key: '...', Bucket: '...' }
  
      logger.success(`[S3 Adapter] Finalized multipart upload: ${metadata.s3Key} (ETag: ${response.ETag})`);
  
      // Clean up local metadata AFTER successful S3 completion
      await deleteUploadMetadata(appUploadId);
  
      // Send notification
      sendNotification(metadata.originalFilename, metadata.fileSize, config);
  
      // Return info consistent with local adapter where possible
      return { filename: metadata.originalFilename, size: metadata.fileSize, finalPath: metadata.s3Key };
  
    } catch (err) {
      logger.error(`[S3 Adapter] Failed to complete multipart upload for ${appUploadId} (Key: ${metadata.s3Key}): ${err.message}`);
      // Specific S3 errors like InvalidPartOrder, EntityTooSmall might occur here.
      // If Complete fails, S3 *might* have already assembled it (rare).
      // Check if the object now exists? If so, maybe delete metadata? Complex recovery.
      // For now, just log the error and throw. The local metadata will persist.
      if (err.Code === 'NoSuchUpload') {
          logger.warn(`[S3 Adapter] CompleteMultipartUpload failed with NoSuchUpload for ${appUploadId}. Assuming already completed or aborted.`);
           await deleteUploadMetadata(appUploadId).catch(()=>{}); // Attempt metadata cleanup
           // Check if final object exists?
           try {
              // Use GetObject or HeadObject to check
              await s3Client.send(new GetObjectCommand({ Bucket: config.s3BucketName, Key: metadata.s3Key }));
              logger.info(`[S3 Adapter] Final object ${metadata.s3Key} exists after NoSuchUpload error. Treating as completed.`);
              return { filename: metadata.originalFilename, size: metadata.fileSize, finalPath: metadata.s3Key };
           } catch (headErr) {
              // Final object doesn't exist either.
               throw new Error('Completion failed: Upload session not found and final object does not exist.');
           }
      }
      throw err;
    }
  }
  
  /**
   * Aborts an ongoing S3 multipart upload.
   * @param {string} appUploadId - The application's upload ID.
   * @returns {Promise<void>}
   */
  async function abortUpload(appUploadId) {
    const metadata = await readUploadMetadata(appUploadId);
    if (!metadata || !metadata.s3UploadId) {
      logger.warn(`[S3 Adapter] Abort request for non-existent or completed upload: ${appUploadId}`);
      await deleteUploadMetadata(appUploadId); // Clean up local metadata if it exists anyway
      return;
    }
  
    try {
      const abortCommand = new AbortMultipartUploadCommand({
        Bucket: config.s3BucketName,
        Key: metadata.s3Key,
        UploadId: metadata.s3UploadId,
      });
      await s3Client.send(abortCommand);
      logger.info(`[S3 Adapter] Aborted multipart upload: ${appUploadId} (Key: ${metadata.s3Key})`);
    } catch (err) {
      if (err.name === 'NoSuchUpload') {
        logger.warn(`[S3 Adapter] Multipart upload ${appUploadId} (Key: ${metadata.s3Key}) not found during abort. Already aborted or completed.`);
      } else {
        logger.error(`[S3 Adapter] Failed to abort multipart upload for ${appUploadId} (Key: ${metadata.s3Key}): ${err.message}`);
        // Don't delete local metadata if abort failed, might be retryable or need manual cleanup
        throw err; // Rethrow S3 error
      }
    }
  
    // Delete local metadata AFTER successful abort or if NoSuchUpload
    await deleteUploadMetadata(appUploadId);
  }
  
  /**
   * Lists files in the S3 bucket.
   * @returns {Promise<Array<{filename: string, size: number, formattedSize: string, uploadDate: Date}>>} List of files.
   */
  async function listFiles() {
    try {
      const command = new ListObjectsV2Command({
        Bucket: config.s3BucketName,
        // Optional: Add Prefix if you want to list within a specific 'folder'
        // Prefix: 'uploads/'
      });
      // TODO: Add pagination handling if expecting >1000 objects
      const response = await s3Client.send(command);
  
      const files = (response.Contents || [])
          // Optional: Filter out objects that might represent folders if necessary
          // .filter(item => !(item.Key.endsWith('/') && item.Size === 0))
          .map(item => ({
              filename: item.Key, // S3 Key is the filename/path
              size: item.Size,
              formattedSize: formatFileSize(item.Size), // Use utility
              uploadDate: item.LastModified
          }));
  
      // Sort by date, newest first
      files.sort((a, b) => b.uploadDate.getTime() - a.uploadDate.getTime());
  
      return files;
  
    } catch (err) {
      logger.error(`[S3 Adapter] Failed to list objects in bucket ${config.s3BucketName}: ${err.message}`);
      throw err;
    }
  }
  
  /**
   * Generates a presigned URL for downloading an S3 object.
   * @param {string} s3Key - The S3 Key (filename/path) of the object.
   * @returns {Promise<{type: string, value: string}>} Object indicating type ('url') and value (the presigned URL).
   */
  async function getDownloadUrlOrStream(s3Key) {
    // Input `s3Key` is assumed to be sanitized by the calling route/logic
    if (!s3Key || s3Key.includes('..') || s3Key.startsWith('/')) {
        logger.error(`[S3 Adapter] Invalid S3 key detected for download: ${s3Key}`);
        throw new Error('Invalid filename');
    }
  
    try {
      const command = new GetObjectCommand({
        Bucket: config.s3BucketName,
        Key: s3Key,
        // Optional: Override response headers like filename
        // ResponseContentDisposition: `attachment; filename="${path.basename(s3Key)}"`
      });
  
      // Generate presigned URL (expires in 1 hour by default, adjustable)
      const url = await getSignedUrl(s3Client, command, { expiresIn: 3600 });
      logger.info(`[S3 Adapter] Generated presigned URL for ${s3Key}`);
      return { type: 'url', value: url };
  
    } catch (err) {
       logger.error(`[S3 Adapter] Failed to generate presigned URL for ${s3Key}: ${err.message}`);
       if (err.name === 'NoSuchKey') {
           throw new Error('File not found in S3');
       }
       throw err; // Re-throw other S3 errors
    }
  }
  
  /**
   * Deletes an object from the S3 bucket.
   * @param {string} s3Key - The S3 Key (filename/path) of the object to delete.
   * @returns {Promise<void>}
   */
  async function deleteFile(s3Key) {
    // Input `s3Key` is assumed to be sanitized
     if (!s3Key || s3Key.includes('..') || s3Key.startsWith('/')) {
        logger.error(`[S3 Adapter] Invalid S3 key detected for delete: ${s3Key}`);
        throw new Error('Invalid filename');
    }
  
    try {
      const command = new DeleteObjectCommand({
        Bucket: config.s3BucketName,
        Key: s3Key,
      });
      await s3Client.send(command);
      logger.info(`[S3 Adapter] Deleted object: ${s3Key}`);
    } catch (err) {
      // DeleteObject is idempotent, so NoSuchKey isn't typically an error unless you need to know.
      logger.error(`[S3 Adapter] Failed to delete object ${s3Key}: ${err.message}`);
      throw err;
    }
  }
  
  /**
   * Cleans up stale *local* metadata files for S3 uploads.
   * Relies on S3 Lifecycle Policies for actual S3 cleanup.
   * @returns {Promise<void>}
   */
  async function cleanupStale() {
    logger.info('[S3 Adapter] Running cleanup for stale local metadata files...');
    let cleanedCount = 0;
    let checkedCount = 0;
  
    try {
      await ensureMetadataDirExists(); // Re-check
  
      const files = await fs.readdir(METADATA_DIR);
      const now = Date.now();
  
      for (const file of files) {
        if (file.endsWith('.meta')) {
          checkedCount++;
          const appUploadId = file.replace('.meta', '');
          const metaFilePath = path.join(METADATA_DIR, file);
  
          try {
            const data = await fs.readFile(metaFilePath, 'utf8');
            const metadata = JSON.parse(data);
  
            // Check inactivity based on local metadata timestamp
            if (now - (metadata.lastActivity || metadata.createdAt || 0) > UPLOAD_TIMEOUT) {
              logger.warn(`[S3 Adapter] Found stale local metadata: ${file}. Last activity: ${new Date(metadata.lastActivity || metadata.createdAt)}. S3 UploadId: ${metadata.s3UploadId || 'N/A'}`);
  
              // Only delete the LOCAL metadata file. DO NOT ABORT S3 UPLOAD HERE.
              await deleteUploadMetadata(appUploadId); // Use helper
              cleanedCount++;
            }
          } catch (readErr) {
            logger.error(`[S3 Adapter] Error reading/parsing local metadata ${metaFilePath} during cleanup: ${readErr.message}. Skipping.`);
             await fs.unlink(metaFilePath).catch(()=>{ logger.warn(`[S3 Adapter] Failed to delete potentially corrupt local metadata file: ${metaFilePath}`) });
          }
        } else if (file.endsWith('.tmp')) {
           // Clean up potential leftover temp metadata files (same as local adapter)
           const tempMetaPath = path.join(METADATA_DIR, file);
           try {
               const stats = await fs.stat(tempMetaPath);
               if (now - stats.mtime.getTime() > UPLOAD_TIMEOUT) {
                   logger.warn(`[S3 Adapter] Deleting stale temporary local metadata file: ${file}`);
                   await fs.unlink(tempMetaPath);
               }
           } catch (statErr) {
                if (statErr.code !== 'ENOENT') {
                   logger.error(`[S3 Adapter] Error checking temp local metadata file ${tempMetaPath}: ${statErr.message}`);
                }
           }
        }
      }
  
      if (checkedCount > 0 || cleanedCount > 0) {
        logger.info(`[S3 Adapter] Local metadata cleanup finished. Checked: ${checkedCount}, Cleaned stale local files: ${cleanedCount}.`);
      }
  
      // Log the crucial recommendation
      logger.warn(`[S3 Adapter] IMPORTANT: For S3 storage, configure Lifecycle Rules on your bucket (${config.s3BucketName}) or use provider-specific tools to automatically clean up incomplete multipart uploads after a few days. This adapter only cleans up local tracking files.`);
  
    } catch (err) {
       if (err.code === 'ENOENT' && err.path === METADATA_DIR) {
           logger.warn('[S3 Adapter] Local metadata directory not found during cleanup scan.');
       } else {
         logger.error(`[S3 Adapter] Error during local metadata cleanup scan: ${err.message}`);
       }
    }
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