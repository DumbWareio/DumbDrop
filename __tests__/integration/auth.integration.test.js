// Mock rate limiter before requiring app
jest.mock('../../src/middleware/rateLimiter', () => ({
    pinVerifyLimiter: (req, res, next) => next(),
    initUploadLimiter: (req, res, next) => next(),
    chunkUploadLimiter: (req, res, next) => next(),
    downloadLimiter: (req, res, next) => next()
}));

const TEST_IP = '127.0.0.1';

let request;
let app;
let initialize;
let config;
let MAX_ATTEMPTS;
let LOCKOUT_DURATION;
let resetAttempts;

beforeAll(() => {
    // Clear module cache
    jest.resetModules();
    
    // Import modules after mocking
    request = require('supertest');
    const appModule = require('../../src/app');
    const configModule = require('../../src/config');
    const securityModule = require('../../src/utils/security');
    
    app = appModule.app;
    initialize = appModule.initialize;
    config = configModule.config;
    MAX_ATTEMPTS = securityModule.MAX_ATTEMPTS;
    LOCKOUT_DURATION = securityModule.LOCKOUT_DURATION;
    resetAttempts = securityModule.resetAttempts;
});

describe('Authentication Integration', () => {
    beforeEach(async () => {
        // Reset PIN for each test
        delete process.env.DUMBDROP_PIN;
        // Reset config.pin
        config.pin = null;
        // Reset any rate limiting state
        resetAttempts(TEST_IP);
        // Re-initialize app to pick up config changes
        await initialize();
        // Wait a bit to ensure rate limiter is reset
        await new Promise(resolve => setTimeout(resolve, 100));
    });

    describe('PIN Verification', () => {
        it('should allow access without PIN when no PIN is configured', async () => {
            const response = await request(app)
                .post('/api/auth/verify-pin')
                .set('X-Forwarded-For', TEST_IP)
                .send({ pin: '1234' });

            expect(response.status).toBe(200);
            expect(response.body.success).toBe(true);
            expect(response.headers['set-cookie']).toBeDefined();
        });

        it('should validate PIN format', async () => {
            config.pin = '1234';
            
            const invalidPins = ['abc', '12', '12345678901', '', null, undefined];
            
            for (const pin of invalidPins) {
                const response = await request(app)
                    .post('/api/auth/verify-pin')
                    .set('X-Forwarded-For', TEST_IP)
                    .send({ pin });

                expect(response.status).toBe(401);
                expect(response.body.error).toContain('Invalid PIN format');
            }
        });

        it('should verify correct PIN and set cookie', async () => {
            config.pin = '1234';
            
            const response = await request(app)
                .post('/api/auth/verify-pin')
                .set('X-Forwarded-For', TEST_IP)
                .send({ pin: '1234' });

            expect(response.status).toBe(200);
            expect(response.body.success).toBe(true);
            expect(response.headers['set-cookie']).toBeDefined();
            expect(response.headers['set-cookie'][0]).toContain('DUMBDROP_PIN');
        });

        it('should reject incorrect PIN', async () => {
            config.pin = '1234';
            
            const response = await request(app)
                .post('/api/auth/verify-pin')
                .set('X-Forwarded-For', TEST_IP)
                .send({ pin: '5678' });

            expect(response.status).toBe(401);
            expect(response.body.success).toBe(false);
            expect(response.body.error).toContain('Invalid PIN');
        });

        it('should implement rate limiting and lockout', async () => {
            config.pin = '1234';
            
            // Make MAX_ATTEMPTS incorrect attempts
            for (let i = 0; i < MAX_ATTEMPTS; i++) {
                const response = await request(app)
                    .post('/api/auth/verify-pin')
                    .set('X-Forwarded-For', TEST_IP)
                    .send({ pin: '5678' });

                expect(response.status).toBe(401);
                if (i < MAX_ATTEMPTS - 1) {
                    expect(response.body.error).toContain('attempts remaining');
                } else {
                    expect(response.body.error).toContain('Account locked');
                }
            }

            // Additional attempt should be locked out
            const lockedResponse = await request(app)
                .post('/api/auth/verify-pin')
                .set('X-Forwarded-For', TEST_IP)
                .send({ pin: '1234' }); // Even with correct PIN

            expect(lockedResponse.status).toBe(429);
            expect(lockedResponse.body.error).toContain('try again in');
        });

        it('should reset attempt counter after successful login', async () => {
            config.pin = '1234';
            resetAttempts(TEST_IP); // Ensure clean state
            
            // Make some failed attempts
            for (let i = 0; i < MAX_ATTEMPTS - 1; i++) {
                await request(app)
                    .post('/api/auth/verify-pin')
                    .set('X-Forwarded-For', TEST_IP)
                    .send({ pin: '5678' });
            }

            // Wait a bit to ensure rate limiter is reset
            await new Promise(resolve => setTimeout(resolve, 100));

            // Successfully login
            const successResponse = await request(app)
                .post('/api/auth/verify-pin')
                .set('X-Forwarded-For', TEST_IP)
                .send({ pin: '1234' });

            expect(successResponse.status).toBe(200);

            // Should be able to make another attempt
            const nextResponse = await request(app)
                .post('/api/auth/verify-pin')
                .set('X-Forwarded-For', TEST_IP)
                .send({ pin: '5678' });

            expect(nextResponse.status).toBe(401);
            expect(nextResponse.body.error).toContain(`${MAX_ATTEMPTS - 1} attempts remaining`);
        });
    });

    describe('PIN Status Check', () => {
        it('should return correct PIN status when PIN is not set', async () => {
            const response = await request(app)
                .get('/api/auth/pin-required')
                .set('X-Forwarded-For', TEST_IP);

            expect(response.status).toBe(200);
            expect(response.body).toEqual({
                required: false,
                length: 0
            });
        });

        it('should return correct PIN status when PIN is set', async () => {
            config.pin = '123456';
            
            const response = await request(app)
                .get('/api/auth/pin-required')
                .set('X-Forwarded-For', TEST_IP);

            expect(response.status).toBe(200);
            expect(response.body).toEqual({
                required: true,
                length: 6
            });
        });
    });

    describe('Logout', () => {
        it('should clear PIN cookie on logout', async () => {
            config.pin = '1234';
            resetAttempts(TEST_IP); // Ensure clean state
            
            // Wait a bit to ensure rate limiter is reset
            await new Promise(resolve => setTimeout(resolve, 100));
            
            // First login
            const loginResponse = await request(app)
                .post('/api/auth/verify-pin')
                .set('X-Forwarded-For', TEST_IP)
                .send({ pin: '1234' });

            expect(loginResponse.status).toBe(200);
            const cookie = loginResponse.headers['set-cookie'][0];

            // Then logout
            const logoutResponse = await request(app)
                .post('/api/auth/logout')
                .set('X-Forwarded-For', TEST_IP)
                .set('Cookie', cookie);

            expect(logoutResponse.status).toBe(200);
            expect(logoutResponse.body.success).toBe(true);
            expect(logoutResponse.headers['set-cookie'][0]).toContain('DUMBDROP_PIN=;');
        });

        it('should handle logout without existing session', async () => {
            const response = await request(app)
                .post('/api/auth/logout')
                .set('X-Forwarded-For', TEST_IP);

            expect(response.status).toBe(200);
            expect(response.body.success).toBe(true);
        });
    });
}); 