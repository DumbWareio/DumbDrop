const request = require('supertest');
const path = require('path');
const fs = require('fs').promises;
const { app, initialize } = require('../../src/app');

// Import test config
const TEST_CONFIG = {
  port: 3001,
  uploadDir: path.join(__dirname, '../../test_uploads'),
  uploadDisplayPath: path.join(__dirname, '../../test_uploads'),
  maxFileSize: 1024 * 1024, // 1MB
  siteTitle: 'DumbDrop-Test',
  pin: null, // No PIN for tests
  autoUpload: false,
  appriseUrl: null,
  cleanupInterval: 3600000, // 1 hour
  maxAge: 86400000, // 24 hours
};

describe('Upload Flow Integration', () => {
  let authCookie;
  
  beforeAll(async () => {
    // Create test upload directory
    await fs.mkdir(TEST_CONFIG.uploadDir, { recursive: true });
    await initialize();
  });

  beforeEach(async () => {
    // Reset PIN for each test
    delete process.env.DUMBDROP_PIN;
    
    // Ensure upload directory exists and is empty
    await fs.mkdir(TEST_CONFIG.uploadDir, { recursive: true });
    const files = await fs.readdir(TEST_CONFIG.uploadDir);
    await Promise.all(
      files.map(file => 
        fs.unlink(path.join(TEST_CONFIG.uploadDir, file))
      )
    );
  });

  afterAll(async () => {
    // Clean up test directory
    try {
      await fs.rm(TEST_CONFIG.uploadDir, { recursive: true, force: true });
    } catch (err) {
      if (err.code !== 'ENOENT') {
        console.error('Failed to remove test directory:', err);
      }
    }
  });

  async function authenticateWithPin(pin) {
    const response = await request(app)
      .post('/api/auth/verify-pin')
      .send({ pin });
    
    if (response.status === 200) {
      // Extract cookie from response
      const cookies = response.headers['set-cookie'];
      if (cookies) {
        authCookie = cookies[0].split(';')[0];
      }
    }
    return response;
  }

  it('should handle complete upload flow', async () => {
    const testContent = 'Test file content';
    const contentSize = Buffer.from(testContent).length;

    // Initialize upload
    const initResponse = await request(app)
      .post('/api/upload/init')
      .send({
        filename: 'test-file.txt',
        fileSize: contentSize
      })
      .expect(200);

    expect(initResponse.body).toHaveProperty('uploadId');
    const { uploadId } = initResponse.body;

    // Upload file chunk
    const chunk = Buffer.from(testContent);
    const uploadResponse = await request(app)
      .post(`/api/upload/chunk/${uploadId}`)
      .set('Content-Type', 'application/octet-stream')
      .send(chunk)
      .expect(200);

    expect(uploadResponse.body).toHaveProperty('bytesReceived', contentSize);
    expect(uploadResponse.body).toHaveProperty('progress', 100);

    // Wait for file to be written and closed
    await new Promise(resolve => setTimeout(resolve, 500));

    // Verify file exists and content is correct
    const uploadedPath = path.join(TEST_CONFIG.uploadDir, 'test-file.txt');
    const content = await fs.readFile(uploadedPath, 'utf8');
    expect(content).toBe(testContent);
  });

  it('should handle concurrent uploads', async () => {
    const uploadCount = 3;
    const uploads = Array(uploadCount).fill().map(async (_, i) => {
      const testContent = `Test content ${i}`;
      const contentSize = Buffer.from(testContent).length;

      // Initialize upload
      const initResponse = await request(app)
        .post('/api/upload/init')
        .send({
          filename: `test-file-${i}.txt`,
          fileSize: contentSize
        })
        .expect(200);

      const { uploadId } = initResponse.body;
      const chunk = Buffer.from(testContent);
      
      // Upload chunk
      return request(app)
        .post(`/api/upload/chunk/${uploadId}`)
        .set('Content-Type', 'application/octet-stream')
        .send(chunk)
        .expect(200);
    });

    const responses = await Promise.all(uploads);
    expect(responses).toHaveLength(uploadCount);
    
    // Wait for files to be written and closed
    await new Promise(resolve => setTimeout(resolve, 500));
    
    // Verify all uploads succeeded
    for (let i = 0; i < uploadCount; i++) {
      const filePath = path.join(TEST_CONFIG.uploadDir, `test-file-${i}.txt`);
      const content = await fs.readFile(filePath, 'utf8');
      expect(content).toBe(`Test content ${i}`);
    }
  });

  it('should handle upload with PIN protection', async () => {
    // Set test PIN
    process.env.DUMBDROP_PIN = '1234';

    // Authenticate
    const authResponse = await authenticateWithPin('1234');
    expect(authResponse.status).toBe(200);

    // Try upload with valid PIN
    const response = await request(app)
      .post('/api/upload/init')
      .set('Cookie', authCookie)
      .send({
        filename: 'test-file-pin.txt',
        fileSize: 16
      })
      .expect(200);

    expect(response.body).toHaveProperty('uploadId');
  });

  it('should reject upload with incorrect PIN', async () => {
    // Set test PIN and reinitialize app to pick up new PIN
    process.env.DUMBDROP_PIN = '1234';
    await initialize();

    // Try to authenticate with wrong PIN
    const authResponse = await authenticateWithPin('5678');
    expect(authResponse.status).toBe(401);

    // Try upload without valid PIN
    const response = await request(app)
      .post('/api/upload/init')
      .send({
        filename: 'test-file.txt',
        fileSize: 16
      })
      .expect(401);

    expect(response.body).toHaveProperty('error');
  });
}); 