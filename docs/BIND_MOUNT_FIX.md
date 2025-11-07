# Bind Mount Compatibility Fix

## Problem

Files uploaded to DumbDrop were disappearing when using Docker bind mounts (e.g., `-v ./uploads:/app/uploads`). The application only worked correctly with named Docker volumes.

### Root Cause

The path validation function `isPathWithinUploadDir()` was using `fs.realpathSync()` on file paths that didn't exist yet. This caused issues because:

1. **Non-existent paths**: During upload initialization, files haven't been created yet. `fs.realpathSync()` requires the path to exist.
2. **Docker bind mount behavior**: With bind mounts, path resolution behaves differently than with named volumes.
3. **Validation failures**: Path validation would fail silently, causing files to be rejected or written to unexpected locations.

### Previous Implementation

```javascript
function isPathWithinUploadDir(filePath, uploadDir) {
  try {
    // This would fail for non-existent files!
    const realFilePath = fs.realpathSync(filePath);
    const realUploadDir = fs.realpathSync(uploadDir);
    
    const relativePath = path.relative(realUploadDir, realFilePath);
    return !relativePath.startsWith('..');
  } catch (err) {
    return false; // Silently fail - files disappear!
  }
}
```

## Solution

Created a new implementation of `isPathWithinUploadDir()` that:

1. **Works with non-existent files**: Uses `path.resolve()` and `path.normalize()` for files that don't exist yet
2. **Supports existing files**: Uses `fs.realpathSync()` only when the file exists and `requireExists=true`
3. **Handles bind mounts correctly**: Path normalization works consistently across Docker volume types
4. **Provides security**: Still detects path traversal attempts using `path.relative()`

### New Implementation

```javascript
function isPathWithinUploadDir(filePath, uploadDir, requireExists = false) {
  try {
    // Always resolve the upload directory (must exist)
    const realUploadDir = fs.realpathSync(uploadDir);
    
    let resolvedFilePath;
    if (requireExists && fs.existsSync(filePath)) {
      // For existing files, resolve symlinks for security
      resolvedFilePath = fs.realpathSync(filePath);
    } else {
      // For non-existent files (uploads), use path.resolve
      resolvedFilePath = path.resolve(filePath);
    }
    
    // Normalize paths for consistent comparison
    const relativePath = path.relative(
      path.normalize(realUploadDir),
      path.normalize(resolvedFilePath)
    );
    
    // Reject paths outside upload directory
    if (relativePath === '') return true; // Same directory
    if (relativePath.startsWith('..')) return false; // Path traversal
    
    // Windows: Check same drive
    if (process.platform === 'win32') {
      if (resolvedFilePath.split(':')[0] !== realUploadDir.split(':')[0]) {
        return false;
      }
    }
    
    return true;
  } catch (err) {
    logger.error(`Path validation error: ${err.message}`, err);
    return false;
  }
}
```

## Changes Made

### 1. Updated `src/utils/fileUtils.js`

- Added the new `isPathWithinUploadDir()` function
- Exported it for use across the application
- Made it a shared utility to ensure consistency

### 2. Updated `src/routes/files.js`

- Import `isPathWithinUploadDir` from `fileUtils`
- Use `requireExists=true` for operations on existing files:
  - File info (`/info/*`)
  - File download (`/download/*`)
  - File deletion (`DELETE /*`)
  - File rename source path
- Use `requireExists=false` for rename destination (doesn't exist yet)

### 3. Updated `src/routes/upload.js`

- Import `isPathWithinUploadDir` from `fileUtils`
- Added path validation at key points:
  - Initial file path construction
  - After folder mapping
  - After unique path generation
  - For `.partial` file paths
- All use `requireExists=false` since files are being created

### 4. Added Tests

Created `test/path-validation.test.js` with comprehensive tests:
- ✅ Valid paths within upload directory
- ✅ Nested folder structures
- ✅ Paths with spaces and special characters
- ✅ Path traversal attack detection
- ✅ .partial file extensions
- ✅ Existing vs non-existing files
- ✅ Windows drive letter validation
- ✅ Unicode filenames
- ✅ Deeply nested folders

## Testing

### Run Path Validation Tests

```bash
npm test -- test/path-validation.test.js
```

### Test with Bind Mounts

#### Docker Compose (bind mount)

```yaml
services:
  dumbdrop:
    image: dumbwareio/dumbdrop:latest
    ports:
      - 3000:3000
    volumes:
      - ./uploads:/app/uploads  # Bind mount - now works!
    environment:
      UPLOAD_DIR: /app/uploads
```

#### Docker Compose (named volume - already worked)

```yaml
services:
  dumbdrop:
    image: dumbwareio/dumbdrop:latest
    ports:
      - 3000:3000
    volumes:
      - dumbdrop_uploads:/app/uploads  # Named volume

volumes:
  dumbdrop_uploads:
```

### Verification Steps

1. Start the application with bind mount configuration
2. Upload a file through the web interface
3. Verify the file appears in the web interface
4. Verify the file exists in the host's `./uploads` directory
5. Restart the container and verify files persist
6. Test file operations:
   - Download
   - Rename
   - Delete
   - Folder uploads

## Security Considerations

The fix maintains security while improving compatibility:

1. **Path traversal protection**: Still detects and blocks `../` attempts
2. **Symlink security**: For existing files, symlinks are resolved and validated
3. **Drive separation** (Windows): Files on different drives are rejected
4. **Upload directory validation**: Upload directory must exist and be accessible
5. **Consistent validation**: Same validation logic used across all routes

## Backward Compatibility

✅ **Fully backward compatible**:
- Named Docker volumes continue to work
- Local development (`./local_uploads`) unaffected
- All existing file operations work as before
- No breaking changes to API or configuration

## Performance Impact

**Minimal**: 
- `path.resolve()` and `path.normalize()` are fast operations
- Only use `fs.realpathSync()` when necessary (existing files)
- No additional filesystem I/O for new uploads

## Related Commits

- [d69a8b2](https://github.com/DumbWareio/DumbDrop/commit/d69a8b25b4008f0a5f037ae56d9647651554af11) - Previous attempt (caused the issue)
- [fc8bff9](https://github.com/DumbWareio/DumbDrop/commit/fc8bff9a1422004d159e19bd5c698da77536a62f) - Related security improvements

## Future Improvements

Potential enhancements:
- Add integration tests with actual Docker bind mounts
- Monitor for performance impact in high-load scenarios
- Consider caching upload directory resolution
- Add metrics for path validation failures

## Summary

This fix resolves the critical issue where files would disappear when using Docker bind mounts. The solution properly handles path validation for both existing and non-existing files while maintaining security against path traversal attacks.

