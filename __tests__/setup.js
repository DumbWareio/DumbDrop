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

let server;
let cleanupTimer;

// Initialize app before all tests
beforeAll(async () => {
  try {
    // Create test upload directory
    await fs.mkdir(path.join(__dirname, '../test_uploads'), { recursive: true });
    
    // Initialize the app
    await initialize();
    
    // Start server
    server = app.listen(process.env.PORT);
  } catch (err) {
    console.error('Test setup failed:', err);
    throw err;
  }
});

// Reset environment before each test
beforeEach(async () => {
  // Reset mocks
  jest.clearAllMocks();
  
  // Reset environment variables
  process.env.NODE_ENV = 'test';
  process.env.PORT = '3001';
  process.env.UPLOAD_DIR = path.join(__dirname, '../test_uploads');
  process.env.MAX_FILE_SIZE = '1'; // 1MB
  process.env.DUMBDROP_TITLE = 'DumbDrop-Test';
  
  // Clear any existing cleanup timers
  if (cleanupTimer) {
    clearInterval(cleanupTimer);
  }
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
  // Clear any cleanup timers
  if (cleanupTimer) {
    clearInterval(cleanupTimer);
  }
  
  // Close server
  if (server) {
    await new Promise((resolve) => server.close(resolve));
  }
  
  // Remove test directory
  try {
    await fs.rm(path.join(__dirname, '../test_uploads'), { recursive: true, force: true });
  } catch (err) {
    if (err.code !== 'ENOENT') {
      console.error('Failed to remove test directory:', err);
    }
  }
}); 