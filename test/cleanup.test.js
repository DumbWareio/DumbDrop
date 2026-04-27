/**
 * Retention cleanup tests
 */

process.env.DISABLE_BATCH_CLEANUP = 'true';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs').promises;
const path = require('path');

const { config } = require('../src/config');
const { cleanupExpiredFiles } = require('../src/utils/cleanup');

describe('Retention cleanup', () => {
  const oldFile = path.join(config.uploadDir, 'expired-test.txt');
  const freshFile = path.join(config.uploadDir, 'fresh-test.txt');

  before(async () => {
    await fs.mkdir(config.uploadDir, { recursive: true });
  });

  after(async () => {
    await fs.unlink(oldFile).catch(() => {});
    await fs.unlink(freshFile).catch(() => {});
  });

  it('should delete files older than 30 days and keep recent files', async () => {
    await fs.writeFile(oldFile, 'old');
    await fs.writeFile(freshFile, 'fresh');

    const now = Date.now();
    const olderThan30Days = new Date(now - (31 * 24 * 60 * 60 * 1000));
    await fs.utimes(oldFile, olderThan30Days, olderThan30Days);

    await cleanupExpiredFiles();

    await fs.access(freshFile);

    let oldFileExists = true;
    try {
      await fs.access(oldFile);
    } catch (err) {
      if (err.code === 'ENOENT') {
        oldFileExists = false;
      } else {
        throw err;
      }
    }

    assert.strictEqual(oldFileExists, false);
  });
});
