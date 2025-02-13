const request = require('supertest');
const path = require('path');
const fs = require('fs').promises;
const { app } = require('../../src/app');

describe('Upload Flow Integration', () => {
  let authCookie;
  
  beforeEach(async () => {
    // Reset PIN for each test
    delete process.env.DUMBDROP_PIN;
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
    const response = await request(app)
      .post('/api/upload/init')
      .send({
        filename: 'test-file.txt',
        fileSize: contentSize
      })
      .expect(200);

    expect(response.body).toHaveProperty('uploadId');
    const { uploadId } = response.body;

    // Upload file chunk
    const chunk = Buffer.from(testContent);
    const uploadResponse = await request(app)
      .post(`/api/upload/chunk/${uploadId}`)
      .set('Content-Type', 'application/octet-stream')
      .send(chunk)
      .expect(200);

    expect(uploadResponse.body).toHaveProperty('bytesReceived', contentSize);
    expect(uploadResponse.body).toHaveProperty('progress', 100);

    // Verify file exists and content is correct
    const uploadedPath = path.join(process.env.UPLOAD_DIR, 'test-file.txt');
    const content = await fs.readFile(uploadedPath, 'utf8');
    expect(content).toBe(testContent);
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
    // Set test PIN
    process.env.DUMBDROP_PIN = '1234';

    // Try to authenticate with wrong PIN
    const authResponse = await authenticateWithPin('wrong-pin');
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

  it('should handle concurrent uploads', async () => {
    const uploadCount = 3;
    const uploads = Array(uploadCount).fill().map(async (_, i) => {
      // Initialize upload
      const initResponse = await request(app)
        .post('/api/upload/init')
        .send({
          filename: `test-file-${i}.txt`,
          fileSize: 16
        })
        .expect(200);

      const { uploadId } = initResponse.body;
      const chunk = Buffer.from(`Test content ${i}`);
      
      // Upload chunk
      return request(app)
        .post(`/api/upload/chunk/${uploadId}`)
        .set('Content-Type', 'application/octet-stream')
        .send(chunk)
        .expect(200);
    });

    const responses = await Promise.all(uploads);
    expect(responses).toHaveLength(uploadCount);
    
    // Verify all uploads succeeded
    for (let i = 0; i < uploadCount; i++) {
      const filePath = path.join(process.env.UPLOAD_DIR, `test-file-${i}.txt`);
      const exists = await fs.access(filePath)
        .then(() => true)
        .catch(() => false);
      expect(exists).toBe(true);
    }
  });
}); 