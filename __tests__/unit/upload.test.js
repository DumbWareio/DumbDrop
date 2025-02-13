const request = require('supertest');
const { app } = require('../../src/app');

// Mock multer before requiring the app
jest.mock('multer', () => {
  return () => ({
    single: () => (req, res, next) => {
      if (!req.files && !req.file) {
        return next();
      }
      
      const timestamp = Date.now();
      const filename = `test-${timestamp}.txt`;
      
      // Simulate multer's file object
      req.file = {
        fieldname: 'file',
        originalname: req.files?.[0]?.originalname || 'test-file.txt',
        encoding: '7bit',
        mimetype: 'text/plain',
        destination: './test_uploads',
        filename,
        path: './test_uploads/' + filename,
        size: 1024
      };
      next();
    }
  });
});

describe('File Upload Functionality', () => {
  test('should successfully initialize upload', async () => {
    const response = await request(app)
      .post('/api/upload/init')
      .send({
        filename: 'test-file.txt',
        fileSize: 1024
      });

    expect(response.status).toBe(200);
    expect(response.body).toHaveProperty('uploadId');
  });

  test('should successfully upload file chunks', async () => {
    // Initialize upload
    const initResponse = await request(app)
      .post('/api/upload/init')
      .send({
        filename: 'test-file.txt',
        fileSize: 16
      });

    expect(initResponse.status).toBe(200);
    const { uploadId } = initResponse.body;

    // Upload chunk
    const chunk = Buffer.from('Test file content');
    const chunkResponse = await request(app)
      .post(`/api/upload/chunk/${uploadId}`)
      .set('Content-Type', 'application/octet-stream')
      .send(chunk);

    expect(chunkResponse.status).toBe(200);
    expect(chunkResponse.body).toHaveProperty('bytesReceived', chunk.length);
    expect(chunkResponse.body).toHaveProperty('progress');
  });

  test('should reject upload initialization without required fields', async () => {
    const response = await request(app)
      .post('/api/upload/init')
      .send({});

    expect(response.status).toBe(400);
    expect(response.body).toHaveProperty('error');
  });

  test('should handle file size limits', async () => {
    const response = await request(app)
      .post('/api/upload/init')
      .send({
        filename: 'large-file.txt',
        fileSize: 1.5 * 1024 * 1024 // 1.5MB (exceeds 1MB limit)
      });

    expect(response.status).toBe(413);
    expect(response.body).toHaveProperty('error');
    expect(response.body.error).toContain('File too large');
  });

  test('should handle invalid upload ID for chunks', async () => {
    const chunk = Buffer.from('Test content');
    const response = await request(app)
      .post('/api/upload/chunk/invalid-id')
      .set('Content-Type', 'application/octet-stream')
      .send(chunk);

    expect(response.status).toBe(404);
    expect(response.body).toHaveProperty('error', 'Upload not found');
  });

  test('should allow upload cancellation', async () => {
    // Initialize upload
    const initResponse = await request(app)
      .post('/api/upload/init')
      .send({
        filename: 'test-cancel.txt',
        fileSize: 1024
      });

    const { uploadId } = initResponse.body;

    // Cancel upload
    const response = await request(app)
      .post(`/api/upload/cancel/${uploadId}`);

    expect(response.status).toBe(200);
    expect(response.body).toHaveProperty('message', 'Upload cancelled');
  });
}); 