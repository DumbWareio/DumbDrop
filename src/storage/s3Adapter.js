/**
 * S3 Storage Adapter
 * Handles file operations for storing files on AWS S3 or S3-compatible services.
 * Implements the storage interface expected by the application routes.
 * Uses local files in '.metadata' directory to track multipart upload progress for large files
 * and to buffer small files before a single PUT.
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
  PutObjectCommand
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
  formatFileSize
} = require('../utils/fileUtils');
const { sendNotification } = require('../services/notifications');

// --- Constants ---
const METADATA_DIR = path.join(config.uploadDir, '.metadata'); // Local dir for metadata state
const TEMP_CHUNK_DIR = path.join(config.uploadDir, '.temp_chunks'); // Local dir for buffering S3 uploads
const UPLOAD_TIMEOUT = 30 * 60 * 1000; // 30 minutes timeout for stale *local* metadata/temp_chunk cleanup
const MIN_S3_TOTAL_SIZE_FOR_MULTIPART = 5 * 1024 * 1024; // 5MB - files smaller than this use single PutObject

// --- Helper function to convert stream to string ---
async function streamToString(stream) {
  if (!stream || typeof stream.pipe !== 'function') return Promise.resolve(null);
  return new Promise((resolve, reject) => {
      const chunks = [];
      stream.on('data', (chunk) => chunks.push(chunk));
      stream.on('error', reject);
      stream.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
  });
}

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
      // logger: console, // Uncomment for extreme SDK verbosity if needed
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
   throw new Error('S3 Client configuration failed. Check S3 environment variables.');
}

// --- Helper Functions for Local State Management ---
async function ensureDirExists(dirPath, purpose) {
  try {
      if (!fsSync.existsSync(dirPath)) {
          await fs.mkdir(dirPath, { recursive: true });
          logger.info(`[S3 Adapter] Created local ${purpose} directory: ${dirPath}`);
      }
      await fs.access(dirPath, fsSync.constants.W_OK);
  } catch (err) {
      logger.error(`[S3 Adapter] Local ${purpose} directory error (${dirPath}): ${err.message}`);
      throw new Error(`Failed to access or create local ${purpose} directory for S3 adapter state: ${dirPath}`);
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
  if (metadata.isMultipartUpload) {
      metadata.parts = metadata.parts || [];
  }
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
if (metadata.isMultipartUpload) {
    metadata.parts = metadata.parts || [];
}
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

Promise.all([
  ensureDirExists(METADATA_DIR, 'metadata'),
  ensureDirExists(TEMP_CHUNK_DIR, 'temporary chunk buffering')
]).catch(err => {
  logger.error(`[S3 Adapter] Critical error ensuring local directories: ${err.message}`);
  process.exit(1);
});

async function initUpload(filename, fileSize, clientBatchId) {
const size = Number(fileSize);
const appUploadId = crypto.randomBytes(16).toString('hex');

const sanitizedFilename = sanitizePathPreserveDirs(filename);
const s3Key = path.normalize(sanitizedFilename)
  .replace(/^(\.\.(\/|\\|$))+/, '')
  .replace(/\\/g, '/')
  .replace(/^\/+/, '');

logger.info(`[S3 Adapter] Init request for S3 Key: ${s3Key}, Size: ${size}`);

const batchId = clientBatchId || `${Date.now()}-${crypto.randomBytes(4).toString('hex').substring(0, 9)}`;
const baseMetadata = {
  appUploadId, s3Key, originalFilename: filename, fileSize: size,
  bytesReceived: 0, batchId, createdAt: Date.now(), lastActivity: Date.now()
};

if (size === 0) {
  try {
    const putCommand = new PutObjectCommand({ Bucket: config.s3BucketName, Key: s3Key, Body: '', ContentLength: 0 });
    await s3Client.send(putCommand);
    logger.success(`[S3 Adapter] Completed zero-byte file upload directly: ${s3Key}`);
    sendNotification(filename, 0, config);
    return { uploadId: `zero-byte-${appUploadId}` };
  } catch (putErr) {
    logger.error(`[S3 Adapter] Failed to put zero-byte object ${s3Key}: ${putErr.message}`);
    throw putErr;
  }
}

const tempFilePath = path.join(TEMP_CHUNK_DIR, `${appUploadId}.upload`);
let metadata;

if (size < MIN_S3_TOTAL_SIZE_FOR_MULTIPART) {
  logger.info(`[S3 Adapter] Small file (< ${MIN_S3_TOTAL_SIZE_FOR_MULTIPART} bytes). Preparing for single PutObject (will buffer fully). Key: ${s3Key}.`);
  metadata = { ...baseMetadata, isMultipartUpload: false, tempFilePath: tempFilePath };
} else {
  logger.info(`[S3 Adapter] Large file (>= ${MIN_S3_TOTAL_SIZE_FOR_MULTIPART} bytes). Preparing for S3 multipart upload. Key: ${s3Key}.`);
  metadata = { ...baseMetadata, isMultipartUpload: true, tempFilePath: tempFilePath, parts: [] }; // Still use tempFilePath for the first part if needed, or to re-assemble
                                                                                                  // For MPU, tempFilePath is primarily for a potential re-assembly or if first part is small.
                                                                                                  // We will always pass a Buffer to UploadPartCommand for reliability with MinIO.
}

await writeUploadMetadata(appUploadId, metadata);
await fs.writeFile(tempFilePath, ''); // Create empty temp file for appending
logger.info(`[S3 Adapter] Initialized upload: ${appUploadId} for ${s3Key}. Temp buffer: ${tempFilePath}. MPU: ${metadata.isMultipartUpload}`);
return { uploadId: appUploadId };
}

async function storeChunk(appUploadId, chunk) {
const chunkSize = chunk.length;
if (!chunkSize) throw new Error('Empty chunk received');

const metadata = await readUploadMetadata(appUploadId);
if (!metadata) {
  logger.warn(`[S3 Adapter] Metadata not found for chunk: ${appUploadId}.`);
  throw new Error('Upload session not found or already completed');
}

// Append chunk to the temporary local file first for ALL uploads (MPU or SinglePut)
// This simplifies logic and ensures we always have the data locally before S3 interaction for the chunk.
try {
  await fs.appendFile(metadata.tempFilePath, chunk);
} catch (appendErr) {
  logger.error(`[S3 Adapter] Failed to append chunk to temp file ${metadata.tempFilePath} for ${appUploadId}: ${appendErr.message}`);
  throw appendErr;
}

metadata.bytesReceived = (metadata.bytesReceived || 0) + chunkSize;
metadata.bytesReceived = Math.min(metadata.bytesReceived, metadata.fileSize);

const completed = metadata.bytesReceived >= metadata.fileSize;
const progress = metadata.fileSize === 0 ? 100 : Math.min(Math.round((metadata.bytesReceived / metadata.fileSize) * 100), 100);

// For MPU, if the current buffered data in tempFilePath reaches a part size (or it's the last chunk),
// then we upload that part from the buffer.
// For single PutObject, we just update metadata. The full temp file is uploaded in completeUpload.

if (metadata.isMultipartUpload) {
  // This logic might need to change if we upload parts as they come.
  // For now, we're buffering the entire file locally even for MPU, then uploading in completeUpload.
  // This is simpler but less efficient for huge MPU files.
  // A more advanced MPU would read from tempFilePath for each part.
  // For now, we'll just update metadata. `completeUpload` will handle the MPU from the fully buffered file.
  // This means `storeChunk` for MPU primarily just buffers locally and updates progress.
  logger.debug(`[S3 Adapter MPU] Chunk buffered to ${metadata.tempFilePath}. Total buffered: ${metadata.bytesReceived}/${metadata.fileSize}. Progress: ${progress}%`);
} else {
  logger.debug(`[S3 Adapter SinglePut] Chunk buffered to ${metadata.tempFilePath}. Total buffered: ${metadata.bytesReceived}/${metadata.fileSize}. Progress: ${progress}%`);
}

await writeUploadMetadata(appUploadId, metadata); // Update bytesReceived and lastActivity

if (completed) {
  logger.info(`[S3 Adapter] All chunks for ${appUploadId} (${metadata.originalFilename}) received locally (${metadata.bytesReceived} bytes). Ready for S3 finalization.`);
}
return { bytesReceived: metadata.bytesReceived, progress, completed };
}

async function completeUpload(appUploadId) {
const metadata = await readUploadMetadata(appUploadId);
if (!metadata) {
  logger.warn(`[S3 Adapter] completeUpload called for ${appUploadId}, but metadata is missing.`);
  throw new Error('Upload completion failed: Metadata not found');
}

if (metadata.bytesReceived < metadata.fileSize) {
  logger.warn(`[S3 Adapter] Attempting to complete upload ${appUploadId} but locally buffered bytes (${metadata.bytesReceived}) are less than expected size (${metadata.fileSize}). This indicates an issue.`);
  // This shouldn't happen if client sends all data.
   throw new Error(`Incomplete data buffered locally for ${appUploadId}`);
}

let fileBuffer;
try {
    fileBuffer = await fs.readFile(metadata.tempFilePath);
    if (fileBuffer.length !== metadata.fileSize) {
        logger.error(`[S3 Adapter] Critical: Buffered file size ${fileBuffer.length} for ${appUploadId} does not match expected metadata size ${metadata.fileSize}.`);
        throw new Error(`Buffered file size mismatch for ${appUploadId}.`);
    }
} catch (readErr) {
    logger.error(`[S3 Adapter] Failed to read fully buffered temp file ${metadata.tempFilePath} for ${appUploadId}: ${readErr.message}`);
    throw readErr;
}

try {
  if (metadata.isMultipartUpload) {
    // Large file: Perform S3 Multipart Upload from the fully buffered file
    // This simplified MPU still buffers the whole file first.
    // A more advanced version would stream parts from the temp file if it's too large for memory.
    logger.info(`[S3 Adapter MPU] Starting MPU for ${metadata.s3Key} from fully buffered temp file.`);
    const s3MpuUploadId = (await s3Client.send(new CreateMultipartUploadCommand({ Bucket: config.s3BucketName, Key: metadata.s3Key }))).UploadId;
    if (!s3MpuUploadId) throw new Error('S3 did not return an UploadId for multipart.');

    const partSize = MIN_S3_TOTAL_SIZE_FOR_MULTIPART; // Use 5MB parts as a standard
    const uploadedParts = [];
    for (let i = 0; i < Math.ceil(metadata.fileSize / partSize); i++) {
      const start = i * partSize;
      const end = Math.min(start + partSize, metadata.fileSize);
      const partBuffer = fileBuffer.subarray(start, end);
      const partNumber = i + 1;

      const uploadPartCmd = new UploadPartCommand({
        Bucket: config.s3BucketName, Key: metadata.s3Key, UploadId: s3MpuUploadId,
        Body: partBuffer, PartNumber: partNumber, ContentLength: partBuffer.length
      });
      const partResponse = await s3Client.send(uploadPartCmd);
      uploadedParts.push({ PartNumber: partNumber, ETag: partResponse.ETag });
      logger.debug(`[S3 Adapter MPU] Uploaded part ${partNumber} for ${metadata.s3Key}`);
    }

    const completeCommand = new CompleteMultipartUploadCommand({
      Bucket: config.s3BucketName, Key: metadata.s3Key, UploadId: s3MpuUploadId,
      MultipartUpload: { Parts: uploadedParts },
    });
    const response = await s3Client.send(completeCommand);
    logger.success(`[S3 Adapter MPU] Finalized: ${metadata.s3Key} (ETag: ${response.ETag})`);
  } else {
    // Small file: Perform Single PutObject from the fully buffered file
    logger.info(`[S3 Adapter SinglePut] Uploading ${metadata.s3Key} via single PutObject from buffer.`);
    const putCommand = new PutObjectCommand({
        Bucket: config.s3BucketName, Key: metadata.s3Key,
        Body: fileBuffer, 
        ContentLength: metadata.fileSize
        // By passing a buffer, SDK calculates SHA256, avoiding streaming signatures that MinIO might dislike.
    });
    await s3Client.send(putCommand);
    logger.success(`[S3 Adapter SinglePut] Finalized (via PutObject with buffered body): ${metadata.s3Key}`);
  }

  // Common post-completion steps
  await fs.unlink(metadata.tempFilePath).catch(err => logger.warn(`[S3 Adapter] Failed to delete final temp file ${metadata.tempFilePath}: ${err.message}`));
  await deleteUploadMetadata(appUploadId);
  sendNotification(metadata.originalFilename, metadata.fileSize, config);
  return { filename: metadata.originalFilename, size: metadata.fileSize, finalPath: metadata.s3Key };

} catch (err) {
  logger.error(`[S3 Adapter] Failed to complete S3 upload for ${appUploadId} (Key: ${metadata.s3Key}, MPU: ${metadata.isMultipartUpload}): ${err.message} ${err.name}`);
  if (err && err.$response) {
      const responseBody = err.$response.body ? await streamToString(err.$response.body) : "No body or body not streamable/already consumed";
      console.error("[S3 Adapter] Raw Error $response details:", {
          statusCode: err.$response.statusCode,
          headers: err.$response.headers,
          body: responseBody
      });
  } else {
      console.error("[S3 Adapter] Error object details (no $response or failed to stringify body):", JSON.stringify(err, Object.getOwnPropertyNames(err), 2));
  }
  // If MPU failed after starting, try to abort it on S3.
  if (metadata.isMultipartUpload && metadata.s3UploadId) { // s3UploadId is set during MPU init
      logger.warn(`[S3 Adapter MPU] Attempting to abort failed MPU ${metadata.s3UploadId} for ${metadata.s3Key}`);
      await s3Client.send(new AbortMultipartUploadCommand({
          Bucket: config.s3BucketName, Key: metadata.s3Key, UploadId: metadata.s3UploadId
      })).catch(abortErr => logger.error(`[S3 Adapter MPU] Failed to abort MPU after error: ${abortErr.message}`));
  }
  throw err;
}
}

async function abortUpload(appUploadId) {
const metadata = await readUploadMetadata(appUploadId);
if (!metadata) {
  logger.warn(`[S3 Adapter] Abort request for non-existent upload: ${appUploadId}`);
  await deleteUploadMetadata(appUploadId);
  return;
}

// Always delete the local temporary buffer file if it exists
if (metadata.tempFilePath) {
  try {
      await fs.unlink(metadata.tempFilePath);
      logger.info(`[S3 Adapter] Deleted temp buffered file on abort: ${metadata.tempFilePath}`);
  } catch (unlinkErr) {
      if (unlinkErr.code !== 'ENOENT') {
          logger.error(`[S3 Adapter] Failed to delete temp file ${metadata.tempFilePath} on abort: ${unlinkErr.message}`);
      }
  }
}

// If it was an MPU that was *successfully initiated* on S3, abort it there.
// Note: s3UploadId is only present if MPU was successfully initiated.
if (metadata.isMultipartUpload && metadata.s3UploadId) {
  try {
    const abortCommand = new AbortMultipartUploadCommand({
      Bucket: config.s3BucketName, Key: metadata.s3Key, UploadId: metadata.s3UploadId,
    });
    await s3Client.send(abortCommand);
    logger.info(`[S3 Adapter MPU] Aborted S3 multipart upload: ${appUploadId} (S3UploadId: ${metadata.s3UploadId})`);
  } catch (err) {
    if (err.name === 'NoSuchUpload') {
      logger.warn(`[S3 Adapter MPU] S3 multipart upload ${metadata.s3UploadId} not found during abort. Already aborted or completed.`);
    } else {
      logger.error(`[S3 Adapter MPU] Failed to abort S3 multipart upload ${metadata.s3UploadId}: ${err.message}`);
      // Don't rethrow here, as local cleanup is more important for this call.
    }
  }
}
await deleteUploadMetadata(appUploadId); // Delete local .meta file
}

async function listFiles() {
try {
  const command = new ListObjectsV2Command({ Bucket: config.s3BucketName });
  const response = await s3Client.send(command);
  const files = (response.Contents || [])
      .map(item => ({
          filename: item.Key,
          size: item.Size,
          formattedSize: formatFileSize(item.Size),
          uploadDate: item.LastModified
      }));
  files.sort((a, b) => b.uploadDate.getTime() - a.uploadDate.getTime());
  return files;
} catch (err) {
  logger.error(`[S3 Adapter] Failed to list objects in bucket ${config.s3BucketName}: ${err.message}`);
  throw err;
}
}

async function getDownloadUrlOrStream(s3Key) {
if (!s3Key || s3Key.includes('..') || s3Key.startsWith('/')) {
    logger.error(`[S3 Adapter] Invalid S3 key detected for download: ${s3Key}`);
    throw new Error('Invalid filename');
}
try {
  const command = new GetObjectCommand({ Bucket: config.s3BucketName, Key: s3Key });
  const url = await getSignedUrl(s3Client, command, { expiresIn: 3600 });
  logger.info(`[S3 Adapter] Generated presigned URL for ${s3Key}`);
  return { type: 'url', value: url };
} catch (err) {
   logger.error(`[S3 Adapter] Failed to generate presigned URL for ${s3Key}: ${err.message}`);
   if (err.name === 'NoSuchKey') {
       throw new Error('File not found in S3');
   }
   throw err;
}
}

async function deleteFile(s3Key) {
 if (!s3Key || s3Key.includes('..') || s3Key.startsWith('/')) {
    logger.error(`[S3 Adapter] Invalid S3 key detected for delete: ${s3Key}`);
    throw new Error('Invalid filename');
}
try {
  const command = new DeleteObjectCommand({ Bucket: config.s3BucketName, Key: s3Key });
  await s3Client.send(command);
  logger.info(`[S3 Adapter] Deleted object: ${s3Key}`);
} catch (err) {
  logger.error(`[S3 Adapter] Failed to delete object ${s3Key}: ${err.message}`);
  throw err;
}
}

async function cleanupStale() {
logger.info('[S3 Adapter] Running cleanup for stale local metadata and temp chunk files...');
let cleanedMetaCount = 0;
let checkedMetaCount = 0;
let cleanedTempFileCount = 0;
const now = Date.now();

try {
  const metaFiles = await fs.readdir(METADATA_DIR);
  for (const file of metaFiles) {
    if (file.endsWith('.meta')) {
      checkedMetaCount++;
      const appUploadId = file.replace('.meta', '');
      const metaFilePath = path.join(METADATA_DIR, file);
      try {
        const data = await fs.readFile(metaFilePath, 'utf8');
        const metadata = JSON.parse(data);
        if (now - (metadata.lastActivity || metadata.createdAt || 0) > UPLOAD_TIMEOUT) {
          logger.warn(`[S3 Adapter] Found stale local metadata: ${file}. Cleaning up associated resources.`);
          if (metadata.tempFilePath) { // tempFilePath is now always present
              await fs.unlink(metadata.tempFilePath)
                  .then(() => { logger.info(`[S3 Adapter] Deleted stale temp chunk file: ${metadata.tempFilePath}`); cleanedTempFileCount++; })
                  .catch(unlinkErr => { if (unlinkErr.code !== 'ENOENT') { logger.error(`[S3 Adapter] Err deleting stale temp file ${metadata.tempFilePath}: ${unlinkErr.message}`);}});
          }
          // If it was an MPU and s3UploadId was created, attempt to abort it on S3 side
          if (metadata.isMultipartUpload && metadata.s3UploadId) {
              logger.info(`[S3 Adapter] Attempting to abort stale S3 MPU: ${metadata.s3UploadId} for key ${metadata.s3Key}`);
              await s3Client.send(new AbortMultipartUploadCommand({
                  Bucket: config.s3BucketName, Key: metadata.s3Key, UploadId: metadata.s3UploadId
              })).catch(abortErr => {
                  if (abortErr.name !== 'NoSuchUpload') { // It's fine if it's already gone
                      logger.error(`[S3 Adapter] Failed to abort stale S3 MPU ${metadata.s3UploadId}: ${abortErr.message}`);
                  }
              });
          }
          await deleteUploadMetadata(appUploadId);
          cleanedMetaCount++;
        }
      } catch (readErr) {
        logger.error(`[S3 Adapter] Error reading/parsing local metadata ${metaFilePath}: ${readErr.message}. Deleting.`);
         await fs.unlink(metaFilePath).catch(()=>{});
      }
    } else if (file.endsWith('.tmp')) {
       const tempMetaPath = path.join(METADATA_DIR, file);
       try {
           const stats = await fs.stat(tempMetaPath);
           if (now - stats.mtime.getTime() > UPLOAD_TIMEOUT) { await fs.unlink(tempMetaPath); }
       } catch (statErr) { if (statErr.code !== 'ENOENT') { logger.error(`[S3 Adapter] Error checking temp meta file ${tempMetaPath}: ${statErr.message}`);}}
    }
  }
} catch (err) {
   if (err.code === 'ENOENT' && err.path === METADATA_DIR) { logger.warn('[S3 Adapter] Local metadata dir not found.'); }
   else { logger.error(`[S3 Adapter] Error during local metadata cleanup: ${err.message}`); }
}

try {
  const tempChunkFiles = await fs.readdir(TEMP_CHUNK_DIR);
  for (const file of tempChunkFiles) {
      const tempFilePath = path.join(TEMP_CHUNK_DIR, file);
      if (file.endsWith('.upload')) {
          try {
              const stats = await fs.stat(tempFilePath);
              if (now - stats.mtime.getTime() > UPLOAD_TIMEOUT) {
                  logger.warn(`[S3 Adapter] Deleting orphaned stale temp chunk file: ${file}`);
                  await fs.unlink(tempFilePath);
                  cleanedTempFileCount++;
              }
          } catch (statErr) { if (statErr.code !== 'ENOENT') {logger.error(`[S3 Adapter] Err statting temp chunk file ${tempFilePath}: ${statErr.message}`);}}
      }
  }
} catch (err) {
    if (err.code === 'ENOENT' && err.path === TEMP_CHUNK_DIR) { logger.warn('[S3 Adapter] Local temp_chunk dir not found.'); }
    else { logger.error(`[S3 Adapter] Error during temp_chunk_dir cleanup: ${err.message}`); }
}

if (checkedMetaCount > 0 || cleanedMetaCount > 0 || cleanedTempFileCount > 0) {
  logger.info(`[S3 Adapter] Local state cleanup: MetaChecked: ${checkedMetaCount}, MetaCleaned: ${cleanedMetaCount}, TempFilesCleaned: ${cleanedTempFileCount}.`);
}
logger.warn(`[S3 Adapter] IMPORTANT: S3 Lifecycle Rules on bucket (${config.s3BucketName}) should be used to clean S3-side incomplete MPUs.`);
}

module.exports = {
initUpload, storeChunk, completeUpload, abortUpload,
listFiles, getDownloadUrlOrStream, deleteFile, cleanupStale
};