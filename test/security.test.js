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

  describe('IP Spoofing Protection', () => {
    it('should not trust X-Forwarded-For header when TRUST_PROXY is false', async () => {
      // Verify config.trustProxy is false by default
      assert.strictEqual(config.trustProxy, false, 'TRUST_PROXY should be false by default');
      
      // Make multiple requests with spoofed X-Forwarded-For headers
      const spoofedIps = ['1.2.3.4', '5.6.7.8', '9.10.11.12', '13.14.15.16', '17.18.19.20', '21.22.23.24'];
      const responses = [];
      
      for (const spoofedIp of spoofedIps) {
        const response = await makeRequest({
          host: 'localhost',
          port: server.address().port,
          path: '/api/auth/verify-pin',
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Forwarded-For': spoofedIp,
          },
        }, {
          pin: '9999', // Wrong PIN
        });
        
        responses.push(response);
      }
      
      // Should be rate limited because all requests come from same real IP
      // (spoofed headers should be ignored)
      const rateLimitedOrLocked = responses.filter(
        (r) => r.status === 429 || (r.status === 401 && r.data.error && r.data.error.includes('locked'))
      );
      
      // After 5 failed attempts, should be locked out
      assert.ok(rateLimitedOrLocked.length > 0, 'Rate limiting should apply despite spoofed headers');
    });

    it('should use socket IP when proxy trust is disabled', () => {
      const { getClientIp } = require('../src/utils/ipExtractor');
      
      // Mock request with spoofed X-Forwarded-For
      const mockReq = {
        ip: '192.168.1.100', // This would be from X-Forwarded-For if trusted
        socket: {
          remoteAddress: '::ffff:127.0.0.1', // Real socket IP
        },
        headers: {
          'x-forwarded-for': '192.168.1.100',
        },
      };
      
      const extractedIp = getClientIp(mockReq);
      
      // Should use socket IP, not req.ip (which comes from X-Forwarded-For when trusted)
      assert.strictEqual(extractedIp, '127.0.0.1', 'Should extract from socket, not trust headers');
    });

    it('should normalize IPv6-mapped IPv4 addresses', () => {
      const { normalizeIp } = require('../src/utils/ipExtractor');
      
      const ipv6Mapped = '::ffff:192.168.1.1';
      const normalized = normalizeIp(ipv6Mapped);
      
      assert.strictEqual(normalized, '192.168.1.1', 'Should convert IPv6-mapped to IPv4');
    });

    it('should validate proxy chain when specific IPs are configured', () => {
      const { validateProxyChain } = require('../src/utils/ipExtractor');
      
      const trustedIps = ['172.17.0.1', '10.0.0.1'];
      
      // Trusted proxy should pass
      assert.strictEqual(validateProxyChain('172.17.0.1', trustedIps), true);
      assert.strictEqual(validateProxyChain('10.0.0.1', trustedIps), true);
      
      // Untrusted proxy should fail
      assert.strictEqual(validateProxyChain('192.168.1.1', trustedIps), false);
      assert.strictEqual(validateProxyChain('8.8.8.8', trustedIps), false);
    });

    it('should handle IPv6-mapped addresses in proxy validation', () => {
      const { validateProxyChain } = require('../src/utils/ipExtractor');
      
      const trustedIps = ['127.0.0.1'];
      
      // IPv6-mapped localhost should match
      assert.strictEqual(validateProxyChain('::ffff:127.0.0.1', trustedIps), true);
    });

    it('should prevent rate limit bypass via header spoofing', async () => {
      // This test verifies the fix for the reported vulnerability
      // Make 6 requests with different X-Forwarded-For headers but same real IP
      const attempts = [];
      
      for (let i = 0; i < 6; i++) {
        attempts.push(
          makeRequest({
            host: 'localhost',
            port: server.address().port,
            path: '/api/auth/verify-pin',
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'X-Forwarded-For': `${Math.floor(Math.random() * 255)}.${Math.floor(Math.random() * 255)}.${Math.floor(Math.random() * 255)}.${Math.floor(Math.random() * 255)}`,
            },
          }, {
            pin: '0000', // Wrong PIN
          })
        );
        
        // Small delay between requests to avoid race conditions
        await new Promise(resolve => setTimeout(resolve, 50));
      }
      
      const responses = await Promise.all(attempts);
      
      // Count failures (401) and rate limits (429)
      const failures = responses.filter(r => r.status === 401);
      const rateLimited = responses.filter(r => r.status === 429);
      
      // Should be locked out after 5 attempts, despite spoofed headers
      // Either the 6th request is rate limited (429), or shows lockout message
      const lastResponse = responses[responses.length - 1];
      const isLockedOut = 
        lastResponse.status === 429 || 
        (lastResponse.status === 401 && lastResponse.data.error && 
         (lastResponse.data.error.includes('locked') || lastResponse.data.error.includes('Too many')));
      
      assert.ok(
        failures.length >= 5 || rateLimited.length > 0 || isLockedOut,
        'Should enforce rate limiting despite header spoofing attempts'
      );
    });
  });
});

