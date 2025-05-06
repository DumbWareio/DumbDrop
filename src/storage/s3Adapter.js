/**
 * S3 Storage Adapter
 * Handles file operations for storing files on AWS S3 or S3-compatible services.
 * Implements the storage interface expected by the application routes.
 * Uses local files in '.metadata' directory to track multipart upload progress.
 * Attempts to make top-level folder prefixes unique per batch if collisions occur.
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
  PutObjectCommand,
  HeadObjectCommand
} = require('@aws-sdk/client-s3');
const { getSignedUrl } = require("@aws-sdk/s3-request-presigner");
const fs = require('fs').promises;
const fsSync = require('fs');
const path = require('path');
const crypto = require('crypto');
const util = require('util'); // For detailed error logging
const { config } = require('../config');
const logger = require('../utils/logger');
const {
  sanitizePathPreserveDirs,
  formatFileSize
} = require('../utils/fileUtils');
const { sendNotification } = require('../services/notifications');

const METADATA_DIR = path.join(config.uploadDir, '.metadata');
const UPLOAD_TIMEOUT = 30 * 60 * 1000; // For local metadata cleanup

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
    if (s3ClientConfig.endpoint) logger.info(`[S3 Adapter] Configuring S3 client for endpoint: ${s3ClientConfig.endpoint}`);
    if (s3ClientConfig.forcePathStyle) logger.info(`[S3 Adapter] Configuring S3 client with forcePathStyle: true`);
    s3Client = new S3Client(s3ClientConfig);
    logger.success('[S3 Adapter] S3 Client configured successfully.');
} catch (error) {
     logger.error(`[S3 Adapter] Failed to configure S3 client: ${error.message}`);
     throw new Error('S3 Client configuration failed. Check S3 environment variables.');
}

// --- Metadata Helper Functions ---
async function ensureMetadataDirExists() {
    try {
        if (!fsSync.existsSync(METADATA_DIR)) {
            await fs.mkdir(METADATA_DIR, { recursive: true });
            logger.info(`[S3 Adapter] Created local metadata directory: ${METADATA_DIR}`);
        }
        await fs.access(METADATA_DIR, fsSync.constants.W_OK);
    } catch (err) {
        logger.error(`[S3 Adapter] Local metadata directory error (${METADATA_DIR}): ${err.message}`);
        throw new Error(`Failed to access or create local metadata directory: ${METADATA_DIR}`);
    }
}

async function readUploadMetadata(uploadId) {
  if (!uploadId || typeof uploadId !== 'string' || uploadId.includes('..')) {
      logger.warn(`[S3 Adapter] Attempted to read metadata with invalid uploadId: ${uploadId}`);
      return null;
  }
  const metaFilePath = path.join(METADATA_DIR, `${uploadId}.meta`);
  try {
    const data = await fs.readFile(metaFilePath, 'utf8');
    const metadata = JSON.parse(data);
    metadata.parts = metadata.parts || [];
    return metadata;
  } catch (err) {
    if (err.code === 'ENOENT') return null;
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
  metadata.parts = metadata.parts || [];
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
    if (err.code !== 'ENOENT') logger.error(`[S3 Adapter] Error deleting metadata file ${uploadId}.meta: ${err.message}`);
  }
}

ensureMetadataDirExists().catch(err => {
    logger.error(`[S3 Adapter] Initialization failed (metadata dir): ${err.message}`);
    process.exit(1);
});

// --- S3 Object/Prefix Utilities ---
const batchS3PrefixMappings = new Map(); // In-memory: originalTopLevelFolder-batchId -> actualS3Prefix

async function s3ObjectExists(key) {
  logger.info(`[S3 Adapter] s3ObjectExists: Checking key "${key}"`);
  try {
      await s3Client.send(new HeadObjectCommand({ Bucket: config.s3BucketName, Key: key }));
      logger.info(`[S3 Adapter] s3ObjectExists: HeadObject success for key "${key}". Key EXISTS.`);
      return true;
  } catch (error) {
      if (error.name === 'NotFound' || error.name === 'NoSuchKey' || (error.$metadata && error.$metadata.httpStatusCode === 404)) {
          logger.info(`[S3 Adapter] s3ObjectExists: Key "${key}" NOT found (404-like error).`);
          return false;
      }
      if (error.name === '403' || (error.$metadata && error.$metadata.httpStatusCode === 403)) {
           logger.warn(`[S3 Adapter] s3ObjectExists: Received 403 Forbidden for key "${key}". For unique key generation, treating as 'likely does not exist'.`);
           return false;
      }
      logger.error(`[S3 Adapter DEBUG] Full error object for HeadObject on key "${key}":\n`, util.inspect(error, { showHidden: false, depth: null, colors: false }));
      logger.error(`[S3 Adapter] s3ObjectExists: Unhandled error type "${error.name}" for key "${key}": ${error.message}`);
      throw error;
  }
}

async function getUniqueS3FolderPrefix(originalPrefix, batchId) {
  if (!originalPrefix || !originalPrefix.endsWith('/')) {
      logger.error("[S3 Adapter] getUniqueS3FolderPrefix: originalPrefix must be a non-empty string ending with '/'");
      return originalPrefix; // Or throw error
  }
  const prefixMapKey = `${originalPrefix}-${batchId}`;
  if (batchS3PrefixMappings.has(prefixMapKey)) {
      return batchS3PrefixMappings.get(prefixMapKey);
  }

  let currentPrefixToCheck = originalPrefix;
  let counter = 1;
  const baseName = originalPrefix.slice(0, -1); // "MyFolder" from "MyFolder/"

  async function prefixHasObjects(prefix) {
      try {
          const listResponse = await s3Client.send(new ListObjectsV2Command({
              Bucket: config.s3BucketName, Prefix: prefix, MaxKeys: 1
          }));
          return listResponse.KeyCount > 0;
      } catch (error) {
          logger.error(`[S3 Adapter] Error listing objects for prefix check "${prefix}": ${error.message}`);
          throw error;
      }
  }

  while (await prefixHasObjects(currentPrefixToCheck)) {
      logger.warn(`[S3 Adapter] S3 prefix "${currentPrefixToCheck}" is not empty. Generating unique prefix for base "${baseName}/".`);
      currentPrefixToCheck = `${baseName}-${counter}/`;
      counter++;
  }

  if (currentPrefixToCheck !== originalPrefix) {
      logger.info(`[S3 Adapter] Using unique S3 folder prefix: "${currentPrefixToCheck}" for original "${originalPrefix}" in batch "${batchId}"`);
  }
  batchS3PrefixMappings.set(prefixMapKey, currentPrefixToCheck);
  return currentPrefixToCheck;
}

// --- Interface Implementation ---
async function initUpload(filename, fileSize, clientBatchId) {
  await ensureMetadataDirExists();
  const size = Number(fileSize);
  const appUploadId = crypto.randomBytes(16).toString('hex');
  const batchId = clientBatchId || `${Date.now()}-${crypto.randomBytes(4).toString('hex').substring(0, 9)}`;

  const originalSanitizedFullpath = sanitizePathPreserveDirs(filename);
  let s3KeyStructure = path.normalize(originalSanitizedFullpath)
      .replace(/^(\.\.(\/|\\|$))+/, '').replace(/\\/g, '/').replace(/^\/+/, '');

  let effectiveBasePrefix = ""; // e.g., "MyFolder-1/" or ""
  const pathParts = s3KeyStructure.split('/');
  const isNestedPath = pathParts.length > 1;
  let relativePathInFolder = s3KeyStructure; // Path of the file relative to its (potentially versioned) folder

  if (isNestedPath) {
      const originalTopLevelFolder = pathParts[0] + '/'; // "MyFolder/"
      effectiveBasePrefix = await getUniqueS3FolderPrefix(originalTopLevelFolder, batchId);
      relativePathInFolder = pathParts.slice(1).join('/'); // "SubFolder/image.jpg" or "image.jpg"
      s3KeyStructure = effectiveBasePrefix + relativePathInFolder; // e.g., "MyFolder-1/SubFolder/image.jpg"
  }
  logger.info(`[S3 Adapter] Init: Original Full Path: "${originalSanitizedFullpath}", Effective Base Prefix: "${effectiveBasePrefix}", Relative Path: "${relativePathInFolder}"`);

  // Now, ensure the s3KeyStructure (which is the full path including the versioned folder prefix)
  // is unique at the file level if it already exists.
  let finalS3Key = s3KeyStructure;
  let fileCounter = 1;
  const fileDir = path.dirname(s3KeyStructure); // Can be "." if not nested within sub-sub-folders
  const fileExt = path.extname(s3KeyStructure);
  const fileBaseName = path.basename(s3KeyStructure, fileExt);

  while (await s3ObjectExists(finalS3Key)) {
      logger.warn(`[S3 Adapter] S3 file key already exists: "${finalS3Key}". Generating unique file key.`);
      finalS3Key = (fileDir === "." ? "" : fileDir + "/") + `${fileBaseName}-${fileCounter}${fileExt}`;
      fileCounter++;
  }
  if (finalS3Key !== s3KeyStructure) {
      logger.info(`[S3 Adapter] Using unique S3 file key: "${finalS3Key}"`);
  }

  // Handle Zero-Byte Files
  if (size === 0) {
    try {
      await s3Client.send(new PutObjectCommand({
        Bucket: config.s3BucketName, Key: finalS3Key, Body: '', ContentLength: 0
      }));
      logger.success(`[S3 Adapter] Completed zero-byte file: ${finalS3Key}`);
      sendNotification(originalSanitizedFullpath, 0, config);
      return { uploadId: `zero-byte-${appUploadId}` };
    } catch (putErr) {
      logger.error(`[S3 Adapter] Failed zero-byte PUT for ${finalS3Key}: ${putErr.message}`);
      throw putErr;
    }
  }

  // Initiate Multipart Upload
  try {
    const createCommand = new CreateMultipartUploadCommand({ Bucket: config.s3BucketName, Key: finalS3Key });
    const response = await s3Client.send(createCommand);
    const s3UploadId = response.UploadId;
    if (!s3UploadId) throw new Error('S3 did not return UploadId');
    logger.info(`[S3 Adapter] Multipart initiated for ${finalS3Key} (S3 UploadId: ${s3UploadId})`);

    const metadata = {
      appUploadId, s3UploadId, s3Key: finalS3Key,
      originalFilename: originalSanitizedFullpath, // Original path from client for notification
      fileSize: size, bytesReceived: 0, parts: [], batchId,
      createdAt: Date.now(), lastActivity: Date.now()
    };
    await writeUploadMetadata(appUploadId, metadata);
    return { uploadId: appUploadId };
  } catch (err) {
    logger.error(`[S3 Adapter] Failed multipart init for ${finalS3Key}: ${err.message}`);
    throw err;
  }
}

async function storeChunk(appUploadId, chunk, partNumber) {
  const chunkSize = chunk.length;
  if (!chunkSize) throw new Error('Empty chunk received');
  if (partNumber < 1) throw new Error('PartNumber must be 1 or greater');

  const metadata = await readUploadMetadata(appUploadId);
  if (!metadata || !metadata.s3UploadId) {
    logger.warn(`[S3 Adapter] Metadata or S3 UploadId not found for chunk: ${appUploadId}`);
    throw new Error('Upload session not found or already completed');
  }
  if (metadata.bytesReceived >= metadata.fileSize && metadata.fileSize > 0) {
     logger.warn(`[S3 Adapter] Chunk for already completed upload ${appUploadId}. Ignoring.`);
     return { bytesReceived: metadata.bytesReceived, progress: 100, completed: true };
  }

  try {
    const cmd = new UploadPartCommand({
      Bucket: config.s3BucketName, Key: metadata.s3Key, UploadId: metadata.s3UploadId,
      Body: chunk, PartNumber: partNumber, ContentLength: chunkSize
    });
    const response = await s3Client.send(cmd);
    const etag = response.ETag;
    if (!etag) throw new Error(`S3 ETag missing for Part ${partNumber}`);

    metadata.parts.push({ PartNumber: partNumber, ETag: etag });
    metadata.parts.sort((a, b) => a.PartNumber - b.PartNumber);
    metadata.bytesReceived = Math.min((metadata.bytesReceived || 0) + chunkSize, metadata.fileSize);
    await writeUploadMetadata(appUploadId, metadata);

    const progress = metadata.fileSize === 0 ? 100 : Math.min(Math.round((metadata.bytesReceived / metadata.fileSize) * 100), 100);
    const completed = metadata.bytesReceived >= metadata.fileSize;
    logger.debug(`[S3 Adapter] Part ${partNumber} for ${appUploadId} (Key: ${metadata.s3Key}). ETag: ${etag}. Progress: ~${progress}%. Completed: ${completed}`);
    return { bytesReceived: metadata.bytesReceived, progress, completed };
  } catch (err) {
    logger.error(`[S3 Adapter] Failed Part ${partNumber} for ${appUploadId} (Key: ${metadata.s3Key}): ${err.message}`);
    throw err;
  }
}

async function completeUpload(appUploadId) {
  const metadata = await readUploadMetadata(appUploadId);
  if (!metadata || !metadata.s3UploadId || !metadata.parts || metadata.parts.length === 0) {
    throw new Error('Upload completion failed: Missing metadata/parts');
  }
  if (metadata.bytesReceived < metadata.fileSize) {
     logger.warn(`[S3 Adapter] Completing ${appUploadId} with ${metadata.bytesReceived}/${metadata.fileSize} bytes tracked.`);
  }
  try {
    const cmd = new CompleteMultipartUploadCommand({
      Bucket: config.s3BucketName, Key: metadata.s3Key, UploadId: metadata.s3UploadId,
      MultipartUpload: { Parts: metadata.parts },
    });
    const response = await s3Client.send(cmd);
    logger.success(`[S3 Adapter] Finalized: ${metadata.s3Key} (ETag: ${response.ETag})`);
    await deleteUploadMetadata(appUploadId);
    sendNotification(metadata.originalFilename, metadata.fileSize, config);
    return { filename: metadata.originalFilename, size: metadata.fileSize, finalPath: metadata.s3Key };
  } catch (err) {
    logger.error(`[S3 Adapter] Failed CompleteMultipartUpload for ${metadata.s3Key}: ${err.message}`);
    if (err.Code === 'NoSuchUpload' || err.name === 'NoSuchUpload') {
        logger.warn(`[S3 Adapter] NoSuchUpload on complete for ${appUploadId}. Assuming completed/aborted.`);
         await deleteUploadMetadata(appUploadId).catch(()=>{});
         try { // Verify if object exists
            await s3Client.send(new HeadObjectCommand({ Bucket: config.s3BucketName, Key: metadata.s3Key }));
            logger.info(`[S3 Adapter] Final object ${metadata.s3Key} exists after NoSuchUpload. Treating as completed.`);
            return { filename: metadata.originalFilename, size: metadata.fileSize, finalPath: metadata.s3Key };
         } catch (headErr) { throw new Error('Completion failed: Session & final object not found.'); }
    }
    throw err;
  }
}

async function abortUpload(appUploadId) {
  const metadata = await readUploadMetadata(appUploadId);
  if (!metadata || !metadata.s3UploadId) {
    logger.warn(`[S3 Adapter] Abort for non-existent/completed upload: ${appUploadId}`);
    await deleteUploadMetadata(appUploadId); return;
  }
  try {
    await s3Client.send(new AbortMultipartUploadCommand({
      Bucket: config.s3BucketName, Key: metadata.s3Key, UploadId: metadata.s3UploadId,
    }));
    logger.info(`[S3 Adapter] Aborted: ${appUploadId} (Key: ${metadata.s3Key})`);
  } catch (err) {
    if (err.name !== 'NoSuchUpload') {
      logger.error(`[S3 Adapter] Failed Abort for ${metadata.s3Key}: ${err.message}`); throw err;
    }
    logger.warn(`[S3 Adapter] NoSuchUpload on abort for ${metadata.s3Key}. Already aborted/completed.`);
  }
  await deleteUploadMetadata(appUploadId);
}

async function listFiles() {
  try {
    let isTruncated = true; let continuationToken; const allFiles = [];
    while(isTruncated) {
        const params = { Bucket: config.s3BucketName };
        if (continuationToken) params.ContinuationToken = continuationToken;
        const response = await s3Client.send(new ListObjectsV2Command(params));
        (response.Contents || []).forEach(item => allFiles.push({
            filename: item.Key, size: item.Size,
            formattedSize: formatFileSize(item.Size), uploadDate: item.LastModified
        }));
        isTruncated = response.IsTruncated;
        continuationToken = response.NextContinuationToken;
    }
    allFiles.sort((a, b) => b.uploadDate.getTime() - a.uploadDate.getTime());
    return allFiles;
  } catch (err) {
    logger.error(`[S3 Adapter] Failed list objects in ${config.s3BucketName}: ${err.message}`); throw err;
  }
}

async function getDownloadUrlOrStream(s3Key) {
  if (!s3Key || s3Key.includes('..') || s3Key.startsWith('/')) throw new Error('Invalid filename for download');
  try {
    const cmd = new GetObjectCommand({ Bucket: config.s3BucketName, Key: s3Key });
    const url = await getSignedUrl(s3Client, cmd, { expiresIn: 3600 });
    logger.info(`[S3 Adapter] Presigned URL for ${s3Key}`);
    return { type: 'url', value: url };
  } catch (err) {
     logger.error(`[S3 Adapter] Failed presigned URL for ${s3Key}: ${err.message}`);
     if (err.name === 'NoSuchKey') throw new Error('File not found in S3'); throw err;
  }
}

async function deleteFile(s3Key) {
   if (!s3Key || s3Key.includes('..') || s3Key.startsWith('/')) throw new Error('Invalid filename for delete');
  try {
    await s3Client.send(new DeleteObjectCommand({ Bucket: config.s3BucketName, Key: s3Key }));
    logger.info(`[S3 Adapter] Deleted: ${s3Key}`);
  } catch (err) {
    logger.error(`[S3 Adapter] Failed delete for ${s3Key}: ${err.message}`); throw err;
  }
}

async function cleanupStale() {
  logger.info('[S3 Adapter] Cleaning stale local metadata...');
  let cleaned = 0, checked = 0;
  try {
    await ensureMetadataDirExists(); const files = await fs.readdir(METADATA_DIR); const now = Date.now();
    for (const file of files) {
      if (file.endsWith('.meta')) {
        checked++; const id = file.replace('.meta',''); const fp = path.join(METADATA_DIR, file);
        try {
          const meta = JSON.parse(await fs.readFile(fp, 'utf8'));
          if (now - (meta.lastActivity || meta.createdAt || 0) > UPLOAD_TIMEOUT) {
            logger.warn(`[S3 Adapter] Stale local meta: ${file}, S3 ID: ${meta.s3UploadId||'N/A'}`);
            await deleteUploadMetadata(id); cleaned++;
          }
        } catch (e) { logger.error(`[S3 Adapter] Error parsing meta ${fp}: ${e.message}`); await fs.unlink(fp).catch(()=>{}); }
      } else if (file.endsWith('.tmp')) {
         const tmpP = path.join(METADATA_DIR, file);
         try { if (now - (await fs.stat(tmpP)).mtime.getTime() > UPLOAD_TIMEOUT) { logger.warn(`[S3 Adapter] Deleting stale tmp meta: ${file}`); await fs.unlink(tmpP); }}
         catch (e) { if (e.code!=='ENOENT') logger.error(`[S3 Adapter] Error stat/unlink tmp meta ${tmpP}: ${e.message}`);}
      }
    }
    if (checked > 0 || cleaned > 0) logger.info(`[S3 Adapter] Local meta cleanup: Checked ${checked}, Cleaned ${cleaned}.`);
    logger.warn(`[S3 Adapter] IMPORTANT: Configure S3 Lifecycle Rules on bucket '${config.s3BucketName}' to clean incomplete multipart uploads.`);
  } catch (err) {
     if (err.code==='ENOENT'&&err.path===METADATA_DIR) logger.warn('[S3 Adapter] Local meta dir not found for cleanup.');
     else logger.error(`[S3 Adapter] Error local meta cleanup: ${err.message}`);
  }
  // Also clean up the batchS3PrefixMappings to prevent memory leak on long-running server
  // Simple approach: clear if older than BATCH_TIMEOUT (requires storing timestamp, or just clear periodically)
  // For now, let's rely on server restarts to clear this in-memory map.
  // A more robust solution would be to use a TTL cache or integrate with batchActivity cleanup.
  if (batchS3PrefixMappings.size > 1000) { // Arbitrary limit to trigger a clear
      logger.warn(`[S3 Adapter] Clearing batchS3PrefixMappings due to size (${batchS3PrefixMappings.size}). Consider a more robust cleanup for this map if server runs for very long periods with many unique batches.`);
      batchS3PrefixMappings.clear();
  }
}

module.exports = {
  initUpload, storeChunk, completeUpload, abortUpload,
  listFiles, getDownloadUrlOrStream, deleteFile, cleanupStale
};