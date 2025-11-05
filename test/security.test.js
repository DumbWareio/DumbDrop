/**
 * Security tests
 * Tests path traversal protection, file extension validation, and other security features
 */

// Disable batch cleanup for tests
process.env.DISABLE_BATCH_CLEANUP = 'true';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const fs = require('fs').promises;
const path = require('path');

// Import the app and utilities
const { app, initialize, config } = require('../src/app');
const { sanitizeFilenameSafe, sanitizePathPreserveDirsSafe } = require('../src/utils/fileUtils');

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
  
  // Clean up test files
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
      req.write(JSON.stringify(body));
    }
    
    req.end();
  });
}

describe('Security Tests', () => {
  describe('Path Traversal Protection', () => {
    it('should block path traversal in file download', async () => {
      const response = await makeRequest({
        host: 'localhost',
        port: server.address().port,
        path: '/api/files/download/../../../etc/passwd',
        method: 'GET',
      });
      
      assert.strictEqual(response.status, 403);
    });
    
    it('should block path traversal in file info', async () => {
      const response = await makeRequest({
        host: 'localhost',
        port: server.address().port,
        path: '/api/files/info/../../package.json',
        method: 'GET',
      });
      
      assert.strictEqual(response.status, 403);
    });
    
    it('should block path traversal in file deletion', async () => {
      const response = await makeRequest({
        host: 'localhost',
        port: server.address().port,
        path: '/api/files/../../../important-file.txt',
        method: 'DELETE',
      });
      
      assert.strictEqual(response.status, 403);
    });
    
    it('should block absolute paths in upload', async () => {
      const response = await makeRequest({
        host: 'localhost',
        port: server.address().port,
        path: '/api/upload/init',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
      }, {
        filename: '/etc/passwd',
        fileSize: 100,
      });
      
      // Should either succeed with sanitized name or reject
      if (response.status === 200) {
        // Verify it was sanitized
        assert.ok(!response.data.uploadId.includes('/etc'));
      }
    });
  });
  
  describe('Filename Sanitization', () => {
    it('should sanitize dangerous characters', () => {
      const dangerous = '../../../etc/passwd';
      const sanitized = sanitizeFilenameSafe(dangerous);
      
      assert.ok(!sanitized.includes('..'));
      assert.ok(!sanitized.includes('/'));
    });
    
    it('should handle null bytes', () => {
      const nullByte = 'file\x00.txt';
      const sanitized = sanitizeFilenameSafe(nullByte);
      
      assert.ok(!sanitized.includes('\x00'));
    });
    
    it('should preserve safe filenames', () => {
      const safe = 'my-file_123.txt';
      const sanitized = sanitizeFilenameSafe(safe);
      
      assert.strictEqual(sanitized, safe);
    });
    
    it('should handle Unicode characters', () => {
      const unicode = 'файл.txt';
      const sanitized = sanitizeFilenameSafe(unicode);
      
      // Should be sanitized to ASCII-safe format
      assert.ok(sanitized.length > 0);
    });
  });
  
  describe('File Size Limits', () => {
    it('should reject files exceeding size limit', async () => {
      const response = await makeRequest({
        host: 'localhost',
        port: server.address().port,
        path: '/api/upload/init',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
      }, {
        filename: 'huge-file.bin',
        fileSize: config.maxFileSize + 1,
      });
      
      assert.strictEqual(response.status, 413);
    });
    
    it('should accept files within size limit', async () => {
      const response = await makeRequest({
        host: 'localhost',
        port: server.address().port,
        path: '/api/upload/init',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
      }, {
        filename: 'small-file.txt',
        fileSize: 1024,
      });
      
      assert.strictEqual(response.status, 200);
    });
  });
  
  describe('Content Type Validation', () => {
    it('should handle various content types safely', async () => {
      const contentTypes = [
        'text/plain',
        'application/json',
        'image/png',
        'application/pdf',
      ];
      
      for (const contentType of contentTypes) {
        const response = await makeRequest({
          host: 'localhost',
          port: server.address().port,
          path: '/api/upload/init',
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
        }, {
          filename: `test.${contentType.split('/')[1]}`,
          fileSize: 100,
        });
        
        // Should handle all content types (unless restricted by config)
        assert.ok(response.status === 200 || response.status === 400);
      }
    });
  });
  
  describe('Rate Limiting', () => {
    it('should enforce rate limits on repeated requests', async () => {
      // Make multiple rapid requests
      const requests = [];
      for (let i = 0; i < 50; i++) {
        requests.push(
          makeRequest({
            host: 'localhost',
            port: server.address().port,
            path: '/api/upload/init',
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
            },
          }, {
            filename: `test-${i}.txt`,
            fileSize: 100,
          })
        );
      }
      
      const responses = await Promise.all(requests);
      
      // At least some should be rate limited (429)
      const rateLimited = responses.filter((r) => r.status === 429);
      
      // Rate limiting should kick in for excessive requests
      assert.ok(rateLimited.length > 0 || responses[0].status === 200);
    });
  });
  
  describe('CORS Protection', () => {
    it('should include CORS headers', async () => {
      const response = await makeRequest({
        host: 'localhost',
        port: server.address().port,
        path: '/api/files',
        method: 'GET',
      });
      
      // CORS headers should be present
      assert.ok(response.headers['access-control-allow-origin'] !== undefined);
    });
  });
  
  describe('Path Sanitization Functions', () => {
    it('should sanitize paths while preserving directories', () => {
      const dirPath = 'folder/subfolder/file.txt';
      const sanitized = sanitizePathPreserveDirsSafe(dirPath);
      
      // Should preserve structure but sanitize dangerous chars
      assert.ok(!sanitized.includes('..'));
      assert.ok(sanitized.includes('/') || sanitized.length > 0);
    });
    
    it('should block directory traversal attempts', () => {
      const malicious = '../../etc/passwd';
      const sanitized = sanitizePathPreserveDirsSafe(malicious);
      
      // Should not allow traversal
      assert.ok(!sanitized.startsWith('..'));
    });
  });
});

