const fs = require('fs').promises;
const path = require('path');

const TEST_UPLOAD_DIR = path.join(__dirname, '../test_uploads');

const TEST_CONFIG = {
  port: 3001,
  uploadDir: TEST_UPLOAD_DIR,
  uploadDisplayPath: TEST_UPLOAD_DIR, // Add display path for test environment
  maxFileSize: 1024 * 1024, // 1MB
  siteTitle: 'DumbDrop-Test',
  pin: null, // No PIN for tests
  autoUpload: false,
  appriseUrl: null,
  cleanupInterval: 3600000, // 1 hour
  maxAge: 86400000, // 24 hours
};

// Disable cleanup intervals for tests
process.env.DISABLE_SECURITY_CLEANUP = 'true';
process.env.DISABLE_BATCH_CLEANUP = 'true';

// Mock the config module before requiring app
jest.mock('../src/config', () => {
  return {
    config: {
      port: 3001,
      uploadDir: process.env.TEST_UPLOAD_DIR,
      uploadDisplayPath: process.env.TEST_UPLOAD_DIR, // Add display path
      maxFileSize: 1024 * 1024,
      siteTitle: 'DumbDrop-Test',
      pin: null,
      autoUpload: false,
      appriseUrl: null,
      cleanupInterval: 3600000,
      maxAge: 86400000,
    },
    validateConfig: jest.fn()
  };
});

// Set test upload directory in environment
process.env.TEST_UPLOAD_DIR = TEST_UPLOAD_DIR;

const { app, initialize } = require('../src/app');
const { stopCleanupInterval } = require('../src/utils/security');
const { stopBatchCleanup } = require('../src/routes/upload');

// Mock console to prevent noise during tests
global.console = {
  log: jest.fn(),
  error: jest.fn(),
  warn: jest.fn(),
  info: jest.fn(),
  debug: jest.fn(),
};

let server;

// Initialize app before all tests
beforeAll(async () => {
  try {
    // Create test upload directory
    await fs.mkdir(TEST_CONFIG.uploadDir, { recursive: true });
    
    // Initialize the app
    await initialize();
    
    // Start server
    server = app.listen(TEST_CONFIG.port);
  } catch (err) {
    console.error('Test setup failed:', err);
    throw err;
  }
});

// Reset environment before each test
beforeEach(async () => {
  // Reset mocks
  jest.clearAllMocks();
  
  // Ensure upload directory exists
  await fs.mkdir(TEST_CONFIG.uploadDir, { recursive: true });
});

/**
 * Recursively remove a directory and its contents
 * @param {string} dir - Directory to remove
 */
async function removeDir(dir) {
  try {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    await Promise.all(entries.map(async entry => {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await removeDir(fullPath);
      } else {
        await fs.unlink(fullPath);
      }
    }));
    await fs.rmdir(dir);
  } catch (err) {
    if (err.code !== 'ENOENT') {
      throw err;
    }
  }
}

// Clean up test files after each test
afterEach(async () => {
  await removeDir(TEST_CONFIG.uploadDir);
  await fs.mkdir(TEST_CONFIG.uploadDir, { recursive: true });
});

// Cleanup after all tests
afterAll(async () => {
  // Stop cleanup intervals
  stopCleanupInterval();
  stopBatchCleanup();
  
  // Close server
  if (server) {
    await new Promise((resolve) => server.close(resolve));
  }
  
  // Remove test directory
  await removeDir(TEST_CONFIG.uploadDir);
}); 