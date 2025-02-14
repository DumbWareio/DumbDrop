const express = require('express');
const router = express.Router();
const path = require('path');
const fs = require('fs').promises;
const { config } = require('../config');
const logger = require('../utils/logger');
const { formatFileSize } = require('../utils/fileUtils');

/**
 * Get file information
 */
router.get('/:filename/info', async (req, res) => {
  const filePath = path.join(config.uploadDir, req.params.filename);
  
  try {
    const stats = await fs.stat(filePath);
    const fileInfo = {
      filename: req.params.filename,
      size: stats.size,
      formattedSize: formatFileSize(stats.size),
      uploadDate: stats.mtime,
      mimetype: path.extname(req.params.filename).slice(1)
    };

    res.json(fileInfo);
  } catch (err) {
    logger.error(`Failed to get file info: ${err.message}`);
    res.status(404).json({ error: 'File not found' });
  }
});

/**
 * Download file
 */
router.get('/:filename/download', async (req, res) => {
  const filePath = path.join(config.uploadDir, req.params.filename);
  
  try {
    await fs.access(filePath);
    
    // Set headers for download
    res.setHeader('Content-Disposition', `attachment; filename="${req.params.filename}"`);
    res.setHeader('Content-Type', 'application/octet-stream');
    
    // Stream the file
    const fileStream = require('fs').createReadStream(filePath);
    fileStream.pipe(res);
    
    // Handle errors during streaming
    fileStream.on('error', (err) => {
      logger.error(`File streaming error: ${err.message}`);
      if (!res.headersSent) {
        res.status(500).json({ error: 'Failed to download file' });
      }
    });
    
    logger.info(`File download started: ${req.params.filename}`);
  } catch (err) {
    logger.error(`File download failed: ${err.message}`);
    res.status(404).json({ error: 'File not found' });
  }
});

/**
 * List all files
 */
router.get('/', async (req, res) => {
  try {
    const files = await fs.readdir(config.uploadDir);
    
    // Get stats for all files first
    const fileStatsPromises = files.map(async filename => {
      try {
        const stats = await fs.stat(path.join(config.uploadDir, filename));
        return { filename, stats, valid: stats.isFile() };
      } catch (err) {
        logger.error(`Failed to get stats for file ${filename}: ${err.message}`);
        return { filename, valid: false };
      }
    });

    const fileStats = await Promise.all(fileStatsPromises);
    
    // Filter and map valid files
    const fileList = fileStats
      .filter(file => file.valid)
      .map(({ filename, stats }) => ({
        filename,
        size: stats.size,
        formattedSize: formatFileSize(stats.size),
        uploadDate: stats.mtime
      }));

    // Sort files by upload date (newest first)
    fileList.sort((a, b) => b.uploadDate - a.uploadDate);

    res.json({ 
      files: fileList,
      totalFiles: fileList.length,
      totalSize: fileList.reduce((acc, file) => acc + file.size, 0)
    });
  } catch (err) {
    logger.error(`Failed to list files: ${err.message}`);
    res.status(500).json({ error: 'Failed to list files' });
  }
});

/**
 * Delete file
 */
router.delete('/:filename', async (req, res) => {
  const filePath = path.join(config.uploadDir, req.params.filename);
  
  try {
    await fs.access(filePath);
    await fs.unlink(filePath);
    logger.info(`File deleted: ${req.params.filename}`);
    res.json({ message: 'File deleted successfully' });
  } catch (err) {
    logger.error(`File deletion failed: ${err.message}`);
    res.status(err.code === 'ENOENT' ? 404 : 500).json({ 
      error: err.code === 'ENOENT' ? 'File not found' : 'Failed to delete file' 
    });
  }
});

module.exports = router; 