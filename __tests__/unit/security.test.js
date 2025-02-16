const crypto = require('crypto');

// Mock logger to prevent noise during tests
jest.mock('../../src/utils/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn()
}));

const {
  MAX_ATTEMPTS,
  LOCKOUT_DURATION,
  resetAttempts,
  isLockedOut,
  recordAttempt,
  validatePin,
  safeCompare,
  startCleanupInterval,
  stopCleanupInterval
} = require('../../src/utils/security');

describe('Security Utils', () => {
  beforeEach(() => {
    // Reset all mocks and clear login attempts between tests
    jest.clearAllMocks();
    jest.useFakeTimers();
    // Reset all login attempts
    const testIPs = ['1.1.1.1', '2.2.2.2', '3.3.3.3'];
    testIPs.forEach(ip => resetAttempts(ip));
  });

  afterEach(() => {
    jest.useRealTimers();
    stopCleanupInterval();
  });

  describe('Login Attempt Management', () => {
    const testIP = '1.1.1.1';

    test('should properly record and track login attempts', () => {
      // Record multiple attempts
      for (let i = 1; i <= 3; i++) {
        const attempt = recordAttempt(testIP);
        expect(attempt.count).toBe(i);
        expect(attempt.lastAttempt).toBeLessThanOrEqual(Date.now());
      }

      // Verify not locked out yet
      expect(isLockedOut(testIP)).toBe(false);

      // Record remaining attempts to trigger lockout
      for (let i = 4; i <= MAX_ATTEMPTS; i++) {
        recordAttempt(testIP);
      }

      // Verify lockout
      expect(isLockedOut(testIP)).toBe(true);
    });

    test('should reset attempts correctly', () => {
      // Record some attempts
      recordAttempt(testIP);
      recordAttempt(testIP);
      
      // Reset attempts
      resetAttempts(testIP);
      
      // Verify reset
      expect(isLockedOut(testIP)).toBe(false);
      const newAttempt = recordAttempt(testIP);
      expect(newAttempt.count).toBe(1);
    });

    test('should handle lockout expiration', () => {
      // Record max attempts
      for (let i = 0; i < MAX_ATTEMPTS; i++) {
        recordAttempt(testIP);
      }
      
      // Verify initial lockout
      expect(isLockedOut(testIP)).toBe(true);
      
      // Advance time past lockout duration
      jest.advanceTimersByTime(LOCKOUT_DURATION + 1000);
      
      // Verify lockout expired
      expect(isLockedOut(testIP)).toBe(false);
    });
  });

  describe('PIN Validation', () => {
    test('should validate PIN format correctly', () => {
      // Valid PINs
      expect(validatePin('1234')).toBe('1234');
      expect(validatePin('123456')).toBe('123456');
      expect(validatePin('1234567890')).toBe('1234567890');

      // Invalid PINs
      expect(validatePin('123')).toBeNull(); // Too short
      expect(validatePin('12345678901')).toBeNull(); // Too long
      expect(validatePin('')).toBeNull(); // Empty
      expect(validatePin(null)).toBeNull(); // Null
      expect(validatePin(undefined)).toBeNull(); // Undefined
      expect(validatePin('abcd')).toBeNull(); // Non-numeric
      expect(validatePin('12ab')).toBeNull(); // Mixed (should be rejected)
    });
  });

  describe('Safe String Comparison', () => {
    test('should safely compare strings', () => {
      // Valid comparisons
      expect(safeCompare('test123', 'test123')).toBe(true);
      expect(safeCompare('', '')).toBe(true);
      expect(safeCompare('a', 'b')).toBe(false);
      expect(safeCompare('test123', 'test124')).toBe(false);

      // Invalid inputs
      expect(safeCompare(null, 'test')).toBe(false);
      expect(safeCompare('test', null)).toBe(false);
      expect(safeCompare(undefined, 'test')).toBe(false);
      expect(safeCompare('test', undefined)).toBe(false);
      expect(safeCompare({}, 'test')).toBe(false);
      expect(safeCompare('test', {})).toBe(false);
    });

    test('should handle timing attacks', () => {
      // Mock crypto.timingSafeEqual to verify it's being used
      const mockTimingSafeEqual = jest.spyOn(crypto, 'timingSafeEqual');
      
      safeCompare('test123', 'test123');
      expect(mockTimingSafeEqual).toHaveBeenCalled();
      
      mockTimingSafeEqual.mockRestore();
    });
  });

  describe('Cleanup Interval', () => {
    test('should start and stop cleanup interval', () => {
      const interval = startCleanupInterval();
      expect(interval).toBeDefined();
      
      // Record some attempts
      recordAttempt('1.1.1.1');
      recordAttempt('2.2.2.2');
      
      // Advance time and trigger cleanup
      jest.advanceTimersByTime(LOCKOUT_DURATION + 60000);
      
      // Stop interval
      stopCleanupInterval();
      
      // Verify cleanup occurred
      expect(isLockedOut('1.1.1.1')).toBe(false);
      expect(isLockedOut('2.2.2.2')).toBe(false);
    });

    test('should handle multiple interval starts', () => {
      const interval1 = startCleanupInterval();
      const interval2 = startCleanupInterval();
      
      expect(interval1).not.toBe(interval2);
      
      stopCleanupInterval();
    });
  });
}); 