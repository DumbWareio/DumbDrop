/**
 * Notification service for file upload events.
 * Integrates with Apprise for sending notifications about uploads.
 * Handles message formatting and notification delivery.
 */

const { exec } = require('child_process');
const util = require('util');
const { formatFileSize, calculateDirectorySize } = require('../utils/fileUtils');
const logger = require('../utils/logger');

const execAsync = util.promisify(exec);

/**
 * Send a notification using Apprise
 * @param {string} filename - Name of uploaded file
 * @param {number} fileSize - Size of uploaded file in bytes
 * @param {Object} config - Configuration object
 * @returns {Promise<void>}
 */
async function sendNotification(filename, fileSize, config) {
  const { APPRISE_URL, APPRISE_MESSAGE, APPRISE_SIZE_UNIT, uploadDir } = config;
  
  if (!APPRISE_URL) {
    return;
  }

  try {
    const formattedSize = formatFileSize(fileSize, APPRISE_SIZE_UNIT);
    const totalStorage = formatFileSize(calculateDirectorySize(uploadDir));
    
    // Sanitize the message components
    const sanitizedFilename = JSON.stringify(filename).slice(1, -1);
    const message = APPRISE_MESSAGE
      .replace('{filename}', sanitizedFilename)
      .replace('{size}', formattedSize)
      .replace('{storage}', totalStorage);

    // Use string command for better escaping
    const command = `apprise ${APPRISE_URL} -b "${message}"`;
    await execAsync(command, { shell: true });
    
    logger.info(`Notification sent for: ${sanitizedFilename} (${formattedSize}, Total storage: ${totalStorage})`);
  } catch (err) {
    logger.error(`Failed to send notification: ${err.message}`);
  }
}

module.exports = {
  sendNotification
}; 