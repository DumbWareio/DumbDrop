/**
 * S3 Storage Adapter
 * Handles file operations for storing files on AWS S3 or S3-compatible services.
 * Implements the storage interface expected by the application routes.
 * Uses local files in '.metadata' directory to track multipart upload progress.
 * Buffers individual parts for MPU or entire small files before S3 PUT.
 */

const {
  S3Client, CreateMultipartUploadCommand, UploadPartCommand,
  CompleteMultipartUploadCommand, AbortMultipartUploadCommand, ListObjectsV2Command,
  GetObjectCommand, DeleteObjectCommand, PutObjectCommand
} = require('@aws-sdk/client-s3');
const { getSignedUrl } = require("@aws-sdk/s3-request-presigner");
const fs = require('fs').promises;
const fsSync = require('fs'); // For synchronous checks
const path = require('path');
const crypto = require('crypto');
const { config } = require('../config');
const logger = require('../utils/logger');
const { sanitizePathPreserveDirs, isValidBatchId, formatFileSize } = require('../utils/fileUtils');
const { sendNotification } = require('../services/notifications');

// --- Constants ---
const METADATA_DIR = path.join(config.uploadDir, '.metadata');
const TEMP_CHUNK_DIR = path.join(config.uploadDir, '.temp_chunks'); // For buffering parts or small files
const UPLOAD_TIMEOUT = 30 * 60 * 1000; // 30 min local stale cleanup
const MIN_S3_TOTAL_SIZE_FOR_MULTIPART = 5 * 1024 * 1024; // 5MB
const S3_PART_SIZE = 5 * 1024 * 1024; // Min 5MB for S3 parts (except last)

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

let s3Client;
try {
  s3Client = new S3Client({
      region: config.s3Region,
      credentials: { accessKeyId: config.s3AccessKeyId, secretAccessKey: config.s3SecretAccessKey },
      ...(config.s3EndpointUrl && { endpoint: config.s3EndpointUrl }),
      ...(config.s3ForcePathStyle && { forcePathStyle: true }),
  });
  logger.success('[S3 Adapter] S3 Client configured.');
} catch (error) {
   logger.error(`[S3 Adapter] Failed to configure S3 client: ${error.message}`);
   throw new Error('S3 Client configuration failed.');
}

async function ensureDirExists(dirPath, purpose) {
  try {
      if (!fsSync.existsSync(dirPath)) {
          await fs.mkdir(dirPath, { recursive: true });
          logger.info(`[S3 Adapter] Created local ${purpose} directory: ${dirPath}`);
      }
      await fs.access(dirPath, fsSync.constants.W_OK);
  } catch (err) {
      logger.error(`[S3 Adapter] Local ${purpose} directory error (${dirPath}): ${err.message}`);
      throw new Error(`Failed to access/create local ${purpose} directory: ${dirPath}`);
  }
}

// Metadata functions (read, write, delete) remain largely the same as your last working version.
// Ensure metadata includes: appUploadId, s3Key, originalFilename, fileSize, bytesReceived, batchId,
// createdAt, lastActivity, isMultipartUpload, tempPartPath, s3UploadId (for MPU), parts (for MPU), currentPartBytes (for MPU).

async function readUploadMetadata(uploadId) {
if (!uploadId || typeof uploadId !== 'string' || uploadId.includes('..')) return null;
const metaFilePath = path.join(METADATA_DIR, `${uploadId}.meta`);
try {
  const data = await fs.readFile(metaFilePath, 'utf8');
  const metadata = JSON.parse(data);
  metadata.parts = metadata.parts || []; // Ensure parts array exists if MPU
  return metadata;
} catch (err) {
  if (err.code === 'ENOENT') return null;
  logger.error(`[S3 Adapter] Error reading metadata for ${uploadId}: ${err.message}`);
  throw err;
}
}

async function writeUploadMetadata(uploadId, metadata) {
if (!uploadId || typeof uploadId !== 'string' || uploadId.includes('..')) return;
const metaFilePath = path.join(METADATA_DIR, `${uploadId}.meta`);
metadata.lastActivity = Date.now();
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
  if (!uploadId || typeof uploadId !== 'string' || uploadId.includes('..')) return;
  const metaFilePath = path.join(METADATA_DIR, `${uploadId}.meta`);
  try { await fs.unlink(metaFilePath); }
  catch (err) { if (err.code !== 'ENOENT') logger.error(`[S3 Adapter] Err deleting meta ${uploadId}.meta: ${err.message}`);}
}


Promise.all([
  ensureDirExists(METADATA_DIR, 'metadata'),
  ensureDirExists(TEMP_CHUNK_DIR, 'part/small file buffering')
]).catch(err => { logger.error(`[S3 Adapter] Critical dir ensure error: ${err.message}`); process.exit(1); });

async function initUpload(filename, fileSize, clientBatchId) {
const size = Number(fileSize);
const appUploadId = crypto.randomBytes(16).toString('hex');
const sanitizedFilename = sanitizePathPreserveDirs(filename);
const s3Key = path.normalize(sanitizedFilename).replace(/^(\.\.(\/|\\|$))+/, '').replace(/\\/g, '/').replace(/^\/+/, '');
logger.info(`[S3 Adapter] Init: Key: ${s3Key}, Size: ${size}`);

const batchId = clientBatchId || `${Date.now()}-${crypto.randomBytes(4).toString('hex').substring(0, 9)}`;
const tempPartPath = path.join(TEMP_CHUNK_DIR, `${appUploadId}.partbuffer`); // Buffer for current part or small file

const baseMetadata = {
  appUploadId, s3Key, originalFilename: filename, fileSize: size,
  bytesReceived: 0, batchId, createdAt: Date.now(), lastActivity: Date.now(),
  tempPartPath, currentPartBytes: 0, parts: []
};

if (size === 0) {
  await s3Client.send(new PutObjectCommand({ Bucket: config.s3BucketName, Key: s3Key, Body: '', ContentLength: 0 }));
  logger.success(`[S3 Adapter] Zero-byte uploaded: ${s3Key}`);
  sendNotification(filename, 0, config);
  return { uploadId: `zero-byte-${appUploadId}` };
}

let metadata;
if (size < MIN_S3_TOTAL_SIZE_FOR_MULTIPART) {
  logger.info(`[S3 Adapter] Small file (<${MIN_S3_TOTAL_SIZE_FOR_MULTIPART}B). Will use single PUT.`);
  metadata = { ...baseMetadata, isMultipartUpload: false };
} else {
  logger.info(`[S3 Adapter] Large file (>=${MIN_S3_TOTAL_SIZE_FOR_MULTIPART}B). Will use MPU.`);
  const mpuResponse = await s3Client.send(new CreateMultipartUploadCommand({ Bucket: config.s3BucketName, Key: s3Key }));
  if (!mpuResponse.UploadId) throw new Error('S3 did not return UploadId for MPU.');
  metadata = { ...baseMetadata, isMultipartUpload: true, s3UploadId: mpuResponse.UploadId };
  logger.info(`[S3 Adapter] MPU initiated for ${s3Key}, S3UploadId: ${metadata.s3UploadId}`);
}

await fs.writeFile(tempPartPath, ''); // Create empty buffer file
await writeUploadMetadata(appUploadId, metadata);
logger.info(`[S3 Adapter] Initialized upload ${appUploadId} for ${s3Key}. Temp buffer: ${tempPartPath}. MPU: ${metadata.isMultipartUpload}`);
return { uploadId: appUploadId };
}

async function _uploadBufferedPart(metadata) {
  const partBuffer = await fs.readFile(metadata.tempPartPath);
  if (partBuffer.length === 0) {
      logger.warn(`[S3 Adapter MPU] Attempted to upload empty part for ${metadata.appUploadId}. Skipping.`);
      return; // Don't upload empty parts
  }

  const partNumber = metadata.parts.length + 1;
  logger.info(`[S3 Adapter MPU] Uploading part ${partNumber} (${partBuffer.length} bytes) for ${metadata.appUploadId} (Key: ${metadata.s3Key})`);
  
  const uploadPartCmd = new UploadPartCommand({
      Bucket: config.s3BucketName, Key: metadata.s3Key, UploadId: metadata.s3UploadId,
      Body: partBuffer, PartNumber: partNumber, ContentLength: partBuffer.length
  });
  const partResponse = await s3Client.send(uploadPartCmd);
  metadata.parts.push({ PartNumber: partNumber, ETag: partResponse.ETag });
  
  // Reset buffer for next part
  await fs.writeFile(metadata.tempPartPath, ''); 
  metadata.currentPartBytes = 0;
  logger.info(`[S3 Adapter MPU] Part ${partNumber} uploaded for ${metadata.appUploadId}. ETag: ${partResponse.ETag}`);
}

async function storeChunk(appUploadId, chunk) {
const chunkSize = chunk.length;
if (!chunkSize) throw new Error('Empty chunk received for storeChunk');

const metadata = await readUploadMetadata(appUploadId);
if (!metadata) throw new Error(`Upload session ${appUploadId} not found or already completed.`);

await fs.appendFile(metadata.tempPartPath, chunk);
metadata.bytesReceived += chunkSize;
metadata.currentPartBytes += chunkSize;

let justUploadedAPart = false;
if (metadata.isMultipartUpload) {
  // Upload part if buffer is full or it's the last overall chunk for the file
  const isLastChunkOfFile = metadata.bytesReceived >= metadata.fileSize;
  if (metadata.currentPartBytes >= S3_PART_SIZE || (isLastChunkOfFile && metadata.currentPartBytes > 0)) {
      await _uploadBufferedPart(metadata);
      justUploadedAPart = true; // indicates that currentPartBytes was reset
  }
}

await writeUploadMetadata(appUploadId, metadata); // Persist bytesReceived, parts array, currentPartBytes

const progress = metadata.fileSize === 0 ? 100 : Math.min(Math.round((metadata.bytesReceived / metadata.fileSize) * 100), 100);
const completed = metadata.bytesReceived >= metadata.fileSize;

logger.debug(`[S3 Adapter] Chunk stored for ${appUploadId}. Total ${metadata.bytesReceived}/${metadata.fileSize} (${progress}%). Part buffered: ${metadata.currentPartBytes}. Part uploaded: ${justUploadedAPart}`);
if (completed) logger.info(`[S3 Adapter] All data for ${appUploadId} received locally. Ready for S3 finalization.`);

return { bytesReceived: metadata.bytesReceived, progress, completed };
}

async function completeUpload(appUploadId) {
const metadata = await readUploadMetadata(appUploadId);
if (!metadata) throw new Error(`Cannot complete: Metadata for ${appUploadId} not found.`);

if (metadata.bytesReceived < metadata.fileSize) {
  logger.error(`[S3 Adapter] FATAL: Attempt to complete ${appUploadId} with ${metadata.bytesReceived}/${metadata.fileSize} bytes.`);
  throw new Error(`Incomplete data for ${appUploadId} cannot be finalized.`);
}

try {
  if (metadata.isMultipartUpload) {
    // If there's any data left in the buffer for the last part, upload it
    if (metadata.currentPartBytes > 0) {
      logger.info(`[S3 Adapter MPU] Uploading final remaining buffered part for ${appUploadId}`);
      await _uploadBufferedPart(metadata); // This will also update metadata and save it
      // Re-read metadata to get the final parts list if _uploadBufferedPart wrote it
      const updatedMetadata = await readUploadMetadata(appUploadId); 
      if (!updatedMetadata) throw new Error("Metadata disappeared after final part upload.");
      metadata.parts = updatedMetadata.parts;
    }
    if (!metadata.parts || metadata.parts.length === 0 && metadata.fileSize > 0) { // fileSize > 0 check because a 0 byte file could be MPU if MIN_S3_TOTAL_SIZE_FOR_MULTIPART is 0
        throw new Error(`No parts recorded for MPU ${appUploadId} of size ${metadata.fileSize}. Cannot complete.`);
    }
    const completeCmd = new CompleteMultipartUploadCommand({
      Bucket: config.s3BucketName, Key: metadata.s3Key, UploadId: metadata.s3UploadId,
      MultipartUpload: { Parts: metadata.parts },
    });
    const response = await s3Client.send(completeCmd);
    logger.success(`[S3 Adapter MPU] Finalized: ${metadata.s3Key} (ETag: ${response.ETag})`);
  } else {
    // Single PUT for small files
    const fileBuffer = await fs.readFile(metadata.tempPartPath);
    if (fileBuffer.length !== metadata.fileSize) {
        throw new Error(`Buffered size ${fileBuffer.length} != metadata size ${metadata.fileSize} for ${appUploadId}`);
    }
    logger.info(`[S3 Adapter SinglePut] Uploading ${metadata.s3Key} via single PutObject from buffer.`);
    await s3Client.send(new PutObjectCommand({
        Bucket: config.s3BucketName, Key: metadata.s3Key,
        Body: fileBuffer, ContentLength: metadata.fileSize
    }));
    logger.success(`[S3 Adapter SinglePut] Finalized: ${metadata.s3Key}`);
  }

  await fs.unlink(metadata.tempPartPath).catch(err => logger.warn(`[S3 Adapter] Failed to delete temp part buffer ${metadata.tempPartPath}: ${err.message}`));
  await deleteUploadMetadata(appUploadId);
  sendNotification(metadata.originalFilename, metadata.fileSize, config);
  return { filename: metadata.originalFilename, size: metadata.fileSize, finalPath: metadata.s3Key };

} catch (err) {
  logger.error(`[S3 Adapter] Failed to complete S3 upload for ${appUploadId} (Key: ${metadata.s3Key}, MPU: ${metadata.isMultipartUpload}): ${err.message} ${err.name}`);
  if (err && err.$response) {
      const responseBody = err.$response.body ? await streamToString(err.$response.body) : "No body/streamed";
      console.error("[S3 Adapter] Raw Error $response:", {statusCode: err.$response.statusCode, headers: err.$response.headers, body: responseBody});
  } else {
      console.error("[S3 Adapter] Error object (no $response):", JSON.stringify(err, Object.getOwnPropertyNames(err), 2));
  }
  if (metadata.isMultipartUpload && metadata.s3UploadId) {
      logger.warn(`[S3 Adapter MPU] Attempting to abort failed MPU ${metadata.s3UploadId}`);
      await s3Client.send(new AbortMultipartUploadCommand({ Bucket: config.s3BucketName, Key: metadata.s3Key, UploadId: metadata.s3UploadId }))
          .catch(abortErr => logger.error(`[S3 Adapter MPU] Failed to abort MPU after error: ${abortErr.message}`));
  }
  throw err;
}
}

async function abortUpload(appUploadId) {
const metadata = await readUploadMetadata(appUploadId);
if (!metadata) {
  logger.warn(`[S3 Adapter] Abort: Metadata for ${appUploadId} not found.`);
  await deleteUploadMetadata(appUploadId); // ensure local meta is gone
  const tempPartPath = path.join(TEMP_CHUNK_DIR, `${appUploadId}.partbuffer`); // guess path
  await fs.unlink(tempPartPath).catch(()=>{}); // try delete orphan buffer
  return;
}

if (metadata.tempPartPath) {
  await fs.unlink(metadata.tempPartPath)
      .then(() => logger.info(`[S3 Adapter] Deleted temp part buffer on abort: ${metadata.tempPartPath}`))
      .catch(err => { if (err.code !== 'ENOENT') logger.error(`[S3 Adapter] Err deleting temp buffer ${metadata.tempPartPath} on abort: ${err.message}`);});
}

if (metadata.isMultipartUpload && metadata.s3UploadId) {
  try {
    await s3Client.send(new AbortMultipartUploadCommand({
      Bucket: config.s3BucketName, Key: metadata.s3Key, UploadId: metadata.s3UploadId,
    }));
    logger.info(`[S3 Adapter MPU] Aborted S3 MPU: ${metadata.s3UploadId}`);
  } catch (err) {
    if (err.name !== 'NoSuchUpload') { logger.error(`[S3 Adapter MPU] Failed to abort S3 MPU ${metadata.s3UploadId}: ${err.message}`);}
    else {logger.warn(`[S3 Adapter MPU] S3 MPU ${metadata.s3UploadId} not found during abort (already gone).`);}
  }
}
await deleteUploadMetadata(appUploadId);
}


async function listFiles() {
try {
  const command = new ListObjectsV2Command({ Bucket: config.s3BucketName });
  const response = await s3Client.send(command);
  const files = (response.Contents || [])
      .map(item => ({
          filename: item.Key, size: item.Size,
          formattedSize: formatFileSize(item.Size), uploadDate: item.LastModified
      })).sort((a, b) => b.uploadDate.getTime() - a.uploadDate.getTime());
  return files;
} catch (err) { logger.error(`[S3 Adapter] Failed to list S3 objects: ${err.message}`); throw err; }
}

async function getDownloadUrlOrStream(s3Key) {
if (!s3Key || s3Key.includes('..') || s3Key.startsWith('/')) throw new Error('Invalid S3 key for download');
try {
  const url = await getSignedUrl(s3Client, new GetObjectCommand({ Bucket: config.s3BucketName, Key: s3Key }), { expiresIn: 3600 });
  logger.info(`[S3 Adapter] Generated presigned URL for ${s3Key}`);
  return { type: 'url', value: url };
} catch (err) {
   logger.error(`[S3 Adapter] Failed to get presigned URL for ${s3Key}: ${err.message}`);
   if (err.name === 'NoSuchKey') throw new Error('File not found in S3');
   throw err;
}
}

async function deleteFile(s3Key) {
 if (!s3Key || s3Key.includes('..') || s3Key.startsWith('/')) throw new Error('Invalid S3 key for delete');
try {
  await s3Client.send(new DeleteObjectCommand({ Bucket: config.s3BucketName, Key: s3Key }));
  logger.info(`[S3 Adapter] Deleted S3 object: ${s3Key}`);
} catch (err) { logger.error(`[S3 Adapter] Failed to delete S3 object ${s3Key}: ${err.message}`); throw err; }
}

async function cleanupStale() {
logger.info('[S3 Adapter] Cleaning stale local metadata & temp part buffers...');
let cleanedMeta = 0, checkedMeta = 0, cleanedBuffers = 0;
const now = Date.now();

try { // Stale .meta files
  const metaFiles = await fs.readdir(METADATA_DIR);
  for (const file of metaFiles) {
    if (!file.endsWith('.meta')) continue;
    checkedMeta++;
    const appUploadId = file.replace('.meta', '');
    const metaFilePath = path.join(METADATA_DIR, file);
    try {
      const metadata = JSON.parse(await fs.readFile(metaFilePath, 'utf8'));
      if (now - (metadata.lastActivity || metadata.createdAt || 0) > UPLOAD_TIMEOUT) {
        logger.warn(`[S3 Adapter] Stale meta: ${file}. AppUploadId: ${appUploadId}. Cleaning.`);
        if (metadata.tempPartPath) {
          await fs.unlink(metadata.tempPartPath).then(()=>cleanedBuffers++).catch(()=>{});
        }
        if (metadata.isMultipartUpload && metadata.s3UploadId) {
          await s3Client.send(new AbortMultipartUploadCommand({ Bucket: config.s3BucketName, Key: metadata.s3Key, UploadId: metadata.s3UploadId }))
              .catch(e => {if (e.name !== 'NoSuchUpload') logger.error(`Stale MPU abort fail: ${e.message}`);});
        }
        await fs.unlink(metaFilePath);
        cleanedMeta++;
      }
    } catch (e) { logger.error(`Error processing stale meta ${file}: ${e.message}. Deleting.`); await fs.unlink(metaFilePath).catch(()=>{});}
  }
} catch (e) { if (e.code !== 'ENOENT') logger.error(`Meta dir cleanup error: ${e.message}`);}

try { // Orphaned .partbuffer files
  const bufferFiles = await fs.readdir(TEMP_CHUNK_DIR);
  for (const file of bufferFiles) {
    if (!file.endsWith('.partbuffer')) continue;
    const bufferFilePath = path.join(TEMP_CHUNK_DIR, file);
    const stats = await fs.stat(bufferFilePath);
    if (now - stats.mtime.getTime() > UPLOAD_TIMEOUT) {
      logger.warn(`[S3 Adapter] Stale orphaned buffer: ${file}. Deleting.`);
      await fs.unlink(bufferFilePath);
      cleanedBuffers++;
    }
  }
} catch (e) { if (e.code !== 'ENOENT') logger.error(`Temp buffer dir cleanup error: ${e.message}`);}

if (checkedMeta || cleanedMeta || cleanedBuffers) {
  logger.info(`[S3 Adapter] Local cleanup: MetaChecked: ${checkedMeta}, MetaCleaned: ${cleanedMeta}, BuffersCleaned: ${cleanedBuffers}.`);
}
logger.warn(`[S3 Adapter] Reminder: Configure S3 Lifecycle Rules on bucket '${config.s3BucketName}' for S3-side MPU cleanup.`);
}

module.exports = {
initUpload, storeChunk, completeUpload, abortUpload,
listFiles, getDownloadUrlOrStream, deleteFile, cleanupStale
};