/**
 * Authentication tests
 * Tests PIN protection and authentication middleware
 */

// Disable batch cleanup for tests
process.env.DISABLE_BATCH_CLEANUP = 'true';

const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert');
const http = require('node:http');

// Import the app
const { app, initialize } = require('../src/app');

let server;
let baseUrl;
const originalPin = process.env.PIN;

before(async () => {
  // Set PIN for testing
  process.env.PIN = '1234';
  
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
  // Restore original PIN
  if (originalPin) {
    process.env.PIN = originalPin;
  } else {
    delete process.env.PIN;
  }
  
  // Close server
  if (server) {
    await new Promise((resolve) => server.close(resolve));
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
          resolve({ status: res.statusCode, data: parsed, headers: res.headers, cookies: res.headers['set-cookie'] });
        } catch {
          resolve({ status: res.statusCode, data, headers: res.headers, cookies: res.headers['set-cookie'] });
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

describe('Authentication API Tests', () => {
  describe('GET /api/auth/pin-required', () => {
    it('should indicate if PIN is required', async () => {
      const response = await makeRequest({
        host: 'localhost',
        port: server.address().port,
        path: '/api/auth/pin-required',
        method: 'GET',
      });
      
      assert.strictEqual(response.status, 200);
      assert.strictEqual(typeof response.data.required, 'boolean');
    });
  });
  
  describe('POST /api/auth/verify-pin', () => {
    it('should accept correct PIN', async () => {
      const response = await makeRequest({
        host: 'localhost',
        port: server.address().port,
        path: '/api/auth/verify-pin',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
      }, {
        pin: '1234',
      });
      
      assert.strictEqual(response.status, 200);
      assert.ok(response.cookies);
    });
    
    it('should reject incorrect PIN', async () => {
      const response = await makeRequest({
        host: 'localhost',
        port: server.address().port,
        path: '/api/auth/verify-pin',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
      }, {
        pin: 'wrong',
      });
      
      assert.strictEqual(response.status, 401);
    });
    
    it('should reject empty PIN', async () => {
      const response = await makeRequest({
        host: 'localhost',
        port: server.address().port,
        path: '/api/auth/verify-pin',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
      }, {
        pin: '',
      });
      
      assert.strictEqual(response.status, 400);
    });
  });
  
  describe('Protected Routes', () => {
    it('should require PIN for upload init', async () => {
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
      
      // Should be redirected or unauthorized without PIN
      assert.ok(response.status === 401 || response.status === 403);
    });
    
    it('should allow upload with valid PIN cookie', async () => {
      // First, get PIN cookie
      const authResponse = await makeRequest({
        host: 'localhost',
        port: server.address().port,
        path: '/api/auth/verify-pin',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
      }, {
        pin: '1234',
      });
      
      // Extract cookie
      const cookies = authResponse.cookies;
      const cookie = cookies ? cookies[0].split(';')[0] : '';
      
      // Try upload with cookie
      const uploadResponse = await makeRequest({
        host: 'localhost',
        port: server.address().port,
        path: '/api/upload/init',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Cookie': cookie,
        },
      }, {
        filename: 'test.txt',
        fileSize: 100,
      });
      
      assert.strictEqual(uploadResponse.status, 200);
    });
  });
  
  describe('POST /api/auth/logout', () => {
    it('should clear authentication cookie', async () => {
      const response = await makeRequest({
        host: 'localhost',
        port: server.address().port,
        path: '/api/auth/logout',
        method: 'POST',
      });
      
      assert.strictEqual(response.status, 200);
    });
  });
});

