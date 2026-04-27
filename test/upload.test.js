/**
 * Upload functionality tests
 * Tests file upload initialization, chunked uploads, and batch operations
 */

// Disable batch cleanup for tests
process.env.DISABLE_BATCH_CLEANUP = 'true';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const fs = require('fs').promises;
const path = require('path');
const crypto = require('crypto');

// Import the app
const { app, initialize, config } = require('../src/app');
const { readUploadMetadata, cleanupFailedUploads, FAILED_UPLOAD_RETENTION_MS } = require('../src/routes/upload');

let server;
let baseUrl;

before(async () => {
  // Initialize app
  await initialize();
  
  // Start server on random port
  server = http.createServer(app);
  await new Promise((resolve) => {
    server.listen(0, () => {
      const { port } = server.address();
      baseUrl = `http://localhost:${port}`;
      resolve();
    });
  });
});

after(async () => {
  // Close server
  if (server) {
    await new Promise((resolve) => server.close(resolve));
  }
  
  // Clean up test uploads
  try {
    const testFiles = await fs.readdir(config.uploadDir);
    for (const file of testFiles) {
      if (file !== '.metadata') {
        const filePath = path.join(config.uploadDir, file);
        const stat = await fs.stat(filePath);
        if (stat.isFile()) {
          await fs.unlink(filePath);
        }
      }
    }
  } catch (err) {
    // Ignore cleanup errors
  }
});

/**
 * Helper function to make HTTP requests
 */
async function makeRequest(options, body = null) {
  return new Promise((resolve, reject) => {
    const req = http.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => {
        data += chunk;
      });
      res.on('end', () => {
        try {
          const parsed = data ? JSON.parse(data) : {};
          resolve({ status: res.statusCode, data: parsed, headers: res.headers });
        } catch {
          resolve({ status: res.statusCode, data, headers: res.headers });
        }
      });
    });
    
    req.on('error', reject);
    
    if (body) {
      if (Buffer.isBuffer(body)) {
        req.write(body);
      } else {
        req.write(JSON.stringify(body));
      }
    }
    
    req.end();
  });
}

describe('Upload API Tests', () => {
  describe('POST /api/upload/init', () => {
    it('should initialize a new upload', async () => {
      const response = await makeRequest({
        host: 'localhost',
        port: server.address().port,
        path: '/api/upload/init',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
      }, {
        filename: 'test.txt',
        fileSize: 100,
      });
      
      assert.strictEqual(response.status, 200);
      assert.ok(response.data.uploadId);
    });
    
    it('should reject uploads without filename', async () => {
      const response = await makeRequest({
        host: 'localhost',
        port: server.address().port,
        path: '/api/upload/init',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
      }, {
        fileSize: 100,
      });
      
      assert.strictEqual(response.status, 400);
      assert.ok(response.data.error);
    });
    
    it('should reject uploads without fileSize', async () => {
      const response = await makeRequest({
        host: 'localhost',
        port: server.address().port,
        path: '/api/upload/init',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
      }, {
        filename: 'test.txt',
      });
      
      assert.strictEqual(response.status, 400);
      assert.ok(response.data.error);
    });
    
    it('should handle zero-byte files', async () => {
      const response = await makeRequest({
        host: 'localhost',
        port: server.address().port,
        path: '/api/upload/init',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
      }, {
        filename: 'empty.txt',
        fileSize: 0,
      });
      
      assert.strictEqual(response.status, 200);
      assert.ok(response.data.uploadId);
      assert.strictEqual(response.data.completed, true);
      assert.ok(response.data.file);
      assert.ok(response.data.file.downloadUrl.endsWith('/empty.txt'));
    });
  });
  
  describe('POST /api/upload/chunk/:uploadId', () => {
    it('should accept chunks for a valid upload', async () => {
      // Initialize upload first
      const initResponse = await makeRequest({
        host: 'localhost',
        port: server.address().port,
        path: '/api/upload/init',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
      }, {
        filename: 'chunk-test.txt',
        fileSize: 50,
      });
      
      const { uploadId } = initResponse.data;
      
      // Send chunk
      const chunk = Buffer.from('Hello, World!');
      const chunkResponse = await makeRequest({
        host: 'localhost',
        port: server.address().port,
        path: `/api/upload/chunk/${uploadId}`,
        method: 'POST',
        headers: {
          'Content-Type': 'application/octet-stream',
        },
      }, chunk);
      
      assert.strictEqual(chunkResponse.status, 200);
      assert.ok(chunkResponse.data.bytesReceived > 0);
    });

    it('should return download link when upload completes', async () => {
      const content = Buffer.from('hello');

      const initResponse = await makeRequest({
        host: 'localhost',
        port: server.address().port,
        path: '/api/upload/init',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
      }, {
        filename: 'complete-test.txt',
        fileSize: content.length,
      });

      const { uploadId } = initResponse.data;

      const chunkResponse = await makeRequest({
        host: 'localhost',
        port: server.address().port,
        path: `/api/upload/chunk/${uploadId}`,
        method: 'POST',
        headers: {
          'Content-Type': 'application/octet-stream',
        },
      }, content);

      assert.strictEqual(chunkResponse.status, 200);
      assert.strictEqual(chunkResponse.data.completed, true);
      assert.ok(chunkResponse.data.file);
      assert.ok(typeof chunkResponse.data.file.downloadUrl === 'string');
      assert.ok(chunkResponse.data.file.downloadUrl.endsWith(`/${chunkResponse.data.file.filename}`));
    });
    
    it('should reject chunks for invalid uploadId', async () => {
      const chunk = Buffer.from('Test data');
      const response = await makeRequest({
        host: 'localhost',
        port: server.address().port,
        path: '/api/upload/chunk/invalid-id',
        method: 'POST',
        headers: {
          'Content-Type': 'application/octet-stream',
        },
      }, chunk);
      
      assert.strictEqual(response.status, 404);
    });
  });
  
  describe('POST /api/upload/cancel/:uploadId', () => {
    it('should cancel an active upload', async () => {
      // Initialize upload
      const initResponse = await makeRequest({
        host: 'localhost',
        port: server.address().port,
        path: '/api/upload/init',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
      }, {
        filename: 'cancel-test.txt',
        fileSize: 100,
      });
      
      const { uploadId } = initResponse.data;
      
      // Cancel upload
      const cancelResponse = await makeRequest({
        host: 'localhost',
        port: server.address().port,
        path: `/api/upload/cancel/${uploadId}`,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
      });
      
      assert.strictEqual(cancelResponse.status, 200);
    });
  });

  describe('POST /api/upload/fail/:uploadId', () => {
    it('should keep partial files briefly and delete them after retention period', async () => {
      const fileContent = Buffer.from('partial-upload-data');

      const initResponse = await makeRequest({
        host: 'localhost',
        port: server.address().port,
        path: '/api/upload/init',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
      }, {
        filename: 'failed-retention.txt',
        fileSize: fileContent.length * 2,
      });

      assert.strictEqual(initResponse.status, 200);
      const { uploadId } = initResponse.data;

      const chunkResponse = await makeRequest({
        host: 'localhost',
        port: server.address().port,
        path: `/api/upload/chunk/${uploadId}`,
        method: 'POST',
        headers: {
          'Content-Type': 'application/octet-stream',
        },
      }, fileContent);

      assert.strictEqual(chunkResponse.status, 200);
      assert.strictEqual(chunkResponse.data.completed, false);

      const failResponse = await makeRequest({
        host: 'localhost',
        port: server.address().port,
        path: `/api/upload/fail/${uploadId}`,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
      });

      assert.strictEqual(failResponse.status, 200);

      const failedMetadata = await readUploadMetadata(uploadId);
      assert.ok(failedMetadata);
      assert.ok(typeof failedMetadata.failedAt === 'number');

      const partialPath = failedMetadata.partialFilePath;
      await fs.stat(partialPath);

      await cleanupFailedUploads(failedMetadata.failedAt + FAILED_UPLOAD_RETENTION_MS - 1);

      const metadataBeforeExpiry = await readUploadMetadata(uploadId);
      assert.ok(metadataBeforeExpiry);
      await fs.stat(partialPath);

      await cleanupFailedUploads(failedMetadata.failedAt + FAILED_UPLOAD_RETENTION_MS + 1);

      const metadataAfterExpiry = await readUploadMetadata(uploadId);
      assert.strictEqual(metadataAfterExpiry, null);
      await assert.rejects(() => fs.stat(partialPath));
    });
  });
  
  describe('Batch uploads', () => {
    it('should handle multiple files with same batch ID', async () => {
      const batchId = `${Date.now()}-${crypto.randomBytes(5).toString('hex').slice(0, 9)}`;
      
      // Initialize first file
      const file1Response = await makeRequest({
        host: 'localhost',
        port: server.address().port,
        path: '/api/upload/init',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Batch-Id': batchId,
        },
      }, {
        filename: 'batch-file1.txt',
        fileSize: 50,
      });
      
      assert.strictEqual(file1Response.status, 200);
      
      // Initialize second file
      const file2Response = await makeRequest({
        host: 'localhost',
        port: server.address().port,
        path: '/api/upload/init',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Batch-Id': batchId,
        },
      }, {
        filename: 'batch-file2.txt',
        fileSize: 50,
      });
      
      assert.strictEqual(file2Response.status, 200);
      assert.notStrictEqual(file1Response.data.uploadId, file2Response.data.uploadId);
    });
  });
});

