/**
 * Path validation tests for bind mount compatibility
 * Tests the isPathWithinUploadDir function with various scenarios
 * Validates both existing and non-existing file paths
 */

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { isPathWithinUploadDir } = require('../src/utils/fileUtils');

describe('Path Validation for Bind Mounts', () => {
  let testUploadDir;
  
  before(() => {
    // Create a temporary upload directory for testing
    testUploadDir = path.join(os.tmpdir(), 'dumbdrop-test-uploads-' + Date.now());
    fs.mkdirSync(testUploadDir, { recursive: true });
  });
  
  after(() => {
    // Clean up test directory
    try {
      fs.rmSync(testUploadDir, { recursive: true, force: true });
    } catch (err) {
      console.error('Failed to clean up test directory:', err);
    }
  });
  
  test('should allow valid file path within upload directory (non-existent file)', () => {
    const filePath = path.join(testUploadDir, 'test-file.txt');
    assert.strictEqual(isPathWithinUploadDir(filePath, testUploadDir, false), true);
  });
  
  test('should allow valid nested file path within upload directory (non-existent)', () => {
    const filePath = path.join(testUploadDir, 'subfolder', 'test-file.txt');
    assert.strictEqual(isPathWithinUploadDir(filePath, testUploadDir, false), true);
  });
  
  test('should allow valid file path with spaces (non-existent)', () => {
    const filePath = path.join(testUploadDir, 'test file with spaces.txt');
    assert.strictEqual(isPathWithinUploadDir(filePath, testUploadDir, false), true);
  });
  
  test('should reject path traversal with ../ (non-existent)', () => {
    const filePath = path.join(testUploadDir, '..', 'malicious.txt');
    assert.strictEqual(isPathWithinUploadDir(filePath, testUploadDir, false), false);
  });
  
  test('should reject path traversal with nested ../ (non-existent)', () => {
    const filePath = path.join(testUploadDir, 'folder', '..', '..', 'malicious.txt');
    assert.strictEqual(isPathWithinUploadDir(filePath, testUploadDir, false), false);
  });
  
  test('should allow upload directory itself', () => {
    assert.strictEqual(isPathWithinUploadDir(testUploadDir, testUploadDir, false), true);
  });
  
  test('should work with .partial file extensions', () => {
    const filePath = path.join(testUploadDir, 'upload.txt.partial');
    assert.strictEqual(isPathWithinUploadDir(filePath, testUploadDir, false), true);
  });
  
  test('should handle paths with normalized separators', () => {
    // Test with forward slashes (cross-platform)
    const filePath = path.normalize(path.join(testUploadDir, 'folder/subfolder/file.txt'));
    assert.strictEqual(isPathWithinUploadDir(filePath, testUploadDir, false), true);
  });
  
  test('should work with existing files when requireExists=true', () => {
    // Create an actual file
    const filePath = path.join(testUploadDir, 'existing-file.txt');
    fs.writeFileSync(filePath, 'test content');
    
    assert.strictEqual(isPathWithinUploadDir(filePath, testUploadDir, true), true);
    
    // Clean up
    fs.unlinkSync(filePath);
  });
  
  test('should reject existing file outside upload directory', () => {
    // Create a file outside the upload directory
    const outsideFile = path.join(os.tmpdir(), 'outside-file.txt');
    fs.writeFileSync(outsideFile, 'test content');
    
    assert.strictEqual(isPathWithinUploadDir(outsideFile, testUploadDir, true), false);
    
    // Clean up
    fs.unlinkSync(outsideFile);
  });
  
  test('should reject paths on different drives (Windows only)', () => {
    if (process.platform !== 'win32') {
      return; // Skip on non-Windows
    }
    
    // Try to use a different drive letter
    const currentDrive = testUploadDir.split(':')[0];
    const differentDrive = currentDrive === 'C' ? 'D' : 'C';
    const differentDrivePath = `${differentDrive}:\\temp\\file.txt`;
    
    // This should be rejected
    assert.strictEqual(isPathWithinUploadDir(differentDrivePath, testUploadDir, false), false);
  });
  
  test('should handle deeply nested folder structures', () => {
    const deepPath = path.join(testUploadDir, 'a', 'b', 'c', 'd', 'e', 'file.txt');
    assert.strictEqual(isPathWithinUploadDir(deepPath, testUploadDir, false), true);
  });
  
  test('should reject absolute paths outside upload directory', () => {
    const outsidePath = path.join(os.tmpdir(), 'outside', 'file.txt');
    assert.strictEqual(isPathWithinUploadDir(outsidePath, testUploadDir, false), false);
  });
});

describe('Path Validation Edge Cases', () => {
  let testUploadDir;
  
  before(() => {
    testUploadDir = path.join(os.tmpdir(), 'dumbdrop-edge-test-' + Date.now());
    fs.mkdirSync(testUploadDir, { recursive: true });
  });
  
  after(() => {
    try {
      fs.rmSync(testUploadDir, { recursive: true, force: true });
    } catch (err) {
      console.error('Failed to clean up test directory:', err);
    }
  });
  
  test('should handle special characters in filenames', () => {
    const filePath = path.join(testUploadDir, 'file (1).txt');
    assert.strictEqual(isPathWithinUploadDir(filePath, testUploadDir, false), true);
  });
  
  test('should handle Unicode filenames', () => {
    const filePath = path.join(testUploadDir, 'файл.txt'); // Russian
    assert.strictEqual(isPathWithinUploadDir(filePath, testUploadDir, false), true);
  });
  
  test('should reject non-existent upload directory', () => {
    const fakeUploadDir = path.join(os.tmpdir(), 'non-existent-dir-' + Date.now());
    const filePath = path.join(fakeUploadDir, 'file.txt');
    
    assert.strictEqual(isPathWithinUploadDir(filePath, fakeUploadDir, false), false);
  });
});

