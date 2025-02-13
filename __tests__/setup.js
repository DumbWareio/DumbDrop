const fs = require('fs').promises;
const path = require('path');
const { app, initialize } = require('../src/app');

// Mock console to prevent noise during tests
global.console = {
  log: jest.fn(),
  error: jest.fn(),
  warn: jest.fn(),
  info: jest.fn(),
  debug: jest.fn(),
};

// Test configuration
process.env.NODE_ENV = 'test';
process.env.PORT = 3001;
process.env.UPLOAD_DIR = path.join(__dirname, '../test_uploads');
process.env.MAX_FILE_SIZE = '1'; // 1MB in test environment
process.env.DUMBDROP_TITLE = 'DumbDrop-Test';

let server;

// Initialize app before all tests
beforeAll(async () => {
  try {
    // Create test upload directory
    await fs.mkdir(process.env.UPLOAD_DIR, { recursive: true });
    
    // Initialize the app
    await initialize();
    
    // Start the server
    return new Promise((resolve) => {
      server = app.listen(process.env.PORT, () => {
        resolve();
      });
    });
  } catch (err) {
    console.error('Test setup failed:', err);
    throw err;
  }
});

// Reset mocks before each test
beforeEach(() => {
  jest.clearAllMocks();
});

// Clean up test files after each test
afterEach(async () => {
  try {
    const files = await fs.readdir(process.env.UPLOAD_DIR);
    await Promise.all(
      files.map(file => 
        fs.unlink(path.join(process.env.UPLOAD_DIR, file))
      )
    );
  } catch (err) {
    if (err.code !== 'ENOENT') {
      throw err;
    }
  }
});

// Cleanup after all tests
afterAll(async () => {
  // Close server
  await new Promise((resolve) => {
    server?.close(resolve);
  });
  
  // Remove test directory using fs.rm instead of deprecated fs.rmdir
  try {
    await fs.rm(process.env.UPLOAD_DIR, { recursive: true, force: true });
  } catch (err) {
    if (err.code !== 'ENOENT') {
      console.error('Failed to remove test directory:', err);
    }
  }
}); 