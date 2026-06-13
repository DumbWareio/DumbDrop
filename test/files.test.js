/**
 * File management tests
 * Tests file listing, downloading, deletion, and renaming operations
 */

// Disable batch cleanup for tests
process.env.DISABLE_BATCH_CLEANUP = 'true';
// Isolate this suite's uploads in a unique temp dir: parallel-safe and avoids
// polluting ./local_uploads. UPLOAD_DIR takes priority and MUST be set before
// the app is imported below, since config reads it once at module load.
process.env.UPLOAD_DIR = require('node:path').join(
  require('node:os').tmpdir(),
  `dumbdrop-test-files-${process.pid}`,
);

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const fs = require('fs').promises;
const path = require('path');

// Import the app
const { app, initialize, config } = require('../src/app');

let server;
let baseUrl;
let testFilePath;

before(async () => {
  // Start from a clean temp dir (guards against stale content from a prior
  // crashed run that reused this pid). initialize() recreates it + .metadata.
  await fs.rm(config.uploadDir, { recursive: true, force: true });
  // Initialize app
  await initialize();

  // Create a test file
  testFilePath = path.join(config.uploadDir, 'test-file.txt');
  await fs.writeFile(testFilePath, 'Test content');
  
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
  
  // Remove the isolated temp upload dir
  try {
    await fs.rm(config.uploadDir, { recursive: true, force: true });
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
      req.write(JSON.stringify(body));
    }
    
    req.end();
  });
}

describe('File Management API Tests', () => {
  describe('GET /api/files', () => {
    it('should list all files', async () => {
      const response = await makeRequest({
        host: 'localhost',
        port: server.address().port,
        path: '/api/files',
        method: 'GET',
      });
      
      assert.strictEqual(response.status, 200);
      assert.ok(Array.isArray(response.data.items));
      assert.ok(response.data.totalFiles >= 0);
    });
  });
  
  describe('GET /api/files/info/*', () => {
    it('should return file info for existing file', async () => {
      const response = await makeRequest({
        host: 'localhost',
        port: server.address().port,
        path: '/api/files/info/test-file.txt',
        method: 'GET',
      });
      
      assert.strictEqual(response.status, 200);
      assert.strictEqual(response.data.filename, 'test-file.txt');
      assert.ok(response.data.size >= 0);
    });
    
    it('should return 404 for non-existent file', async () => {
      const response = await makeRequest({
        host: 'localhost',
        port: server.address().port,
        path: '/api/files/info/nonexistent.txt',
        method: 'GET',
      });
      
      assert.strictEqual(response.status, 404);
    });
    
    it('should prevent path traversal attacks', async () => {
      const response = await makeRequest({
        host: 'localhost',
        port: server.address().port,
        path: '/api/files/info/../../../etc/passwd',
        method: 'GET',
      });
      
      assert.strictEqual(response.status, 403);
    });
  });
  
  describe('GET /api/files/download/*', () => {
    it('should download existing file', async () => {
      const response = await makeRequest({
        host: 'localhost',
        port: server.address().port,
        path: '/api/files/download/test-file.txt',
        method: 'GET',
      });
      
      assert.strictEqual(response.status, 200);
      assert.ok(response.headers['content-disposition']);
    });
    
    it('should return 404 for non-existent file', async () => {
      const response = await makeRequest({
        host: 'localhost',
        port: server.address().port,
        path: '/api/files/download/nonexistent.txt',
        method: 'GET',
      });
      
      assert.strictEqual(response.status, 404);
    });
    
    it('should prevent path traversal in download', async () => {
      const response = await makeRequest({
        host: 'localhost',
        port: server.address().port,
        path: '/api/files/download/../../../etc/passwd',
        method: 'GET',
      });
      
      assert.strictEqual(response.status, 403);
    });
  });
  
  describe('DELETE /api/files/*', () => {
    it('should delete existing file', async () => {
      // Create a file to delete
      const deleteTestPath = path.join(config.uploadDir, 'delete-test.txt');
      await fs.writeFile(deleteTestPath, 'To be deleted');
      
      const response = await makeRequest({
        host: 'localhost',
        port: server.address().port,
        path: '/api/files/delete-test.txt',
        method: 'DELETE',
      });
      
      assert.strictEqual(response.status, 200);
      
      // Verify file is deleted
      try {
        await fs.access(deleteTestPath);
        assert.fail('File should have been deleted');
      } catch (err) {
        assert.strictEqual(err.code, 'ENOENT');
      }
    });
    
    it('should return 404 for non-existent file', async () => {
      const response = await makeRequest({
        host: 'localhost',
        port: server.address().port,
        path: '/api/files/nonexistent.txt',
        method: 'DELETE',
      });
      
      assert.strictEqual(response.status, 404);
    });
    
    it('should prevent path traversal in deletion', async () => {
      const response = await makeRequest({
        host: 'localhost',
        port: server.address().port,
        path: '/api/files/../../../etc/passwd',
        method: 'DELETE',
      });
      
      assert.strictEqual(response.status, 403);
    });
  });
  
  describe('PUT /api/files/rename/*', () => {
    it('should rename existing file', async () => {
      // Create a file to rename
      const renameTestPath = path.join(config.uploadDir, 'rename-test.txt');
      await fs.writeFile(renameTestPath, 'To be renamed');
      
      const response = await makeRequest({
        host: 'localhost',
        port: server.address().port,
        path: '/api/files/rename/rename-test.txt',
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
        },
      }, {
        newName: 'renamed-file.txt',
      });
      
      assert.strictEqual(response.status, 200);

      // Verify new file exists. The hyphen is sanitized to an underscore by
      // sanitizeFilenameSafe, so the stored name is 'renamed_file.txt'.
      assert.strictEqual(response.data.newName, 'renamed_file.txt');
      const newPath = path.join(config.uploadDir, 'renamed_file.txt');
      await fs.access(newPath);
      
      // Clean up
      await fs.unlink(newPath);
    });

    it('should return 404 when renaming a non-existent in-bounds file', async () => {
      const response = await makeRequest({
        host: 'localhost',
        port: server.address().port,
        path: '/api/files/rename/does-not-exist.txt',
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
        },
      }, {
        newName: 'whatever.txt',
      });

      // Missing but in-bounds source: 404, not a misleading 403 traversal block.
      assert.strictEqual(response.status, 404);
    });

    it('should reject empty new name', async () => {
      const response = await makeRequest({
        host: 'localhost',
        port: server.address().port,
        path: '/api/files/rename/test-file.txt',
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
        },
      }, {
        newName: '',
      });
      
      assert.strictEqual(response.status, 400);
    });
    
    it('should prevent path traversal in rename', async () => {
      const response = await makeRequest({
        host: 'localhost',
        port: server.address().port,
        path: '/api/files/rename/../../../etc/passwd',
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
        },
      }, {
        newName: 'hacked.txt',
      });
      
      assert.strictEqual(response.status, 403);
    });
  });
});

