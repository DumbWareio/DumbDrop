/**
 * Demo mode utilities
 * Provides demo banner and demo-related functionality
 * Used to clearly indicate when application is running in demo mode
 */

const multer = require('multer');
const express = require('express');
const router = express.Router();
const logger = require('./logger');
const { config } = require('../config');

const isDemoMode = () => process.env.DEMO_MODE === 'true';

const getDemoBannerHTML = () => `
  <div id="demo-banner" style="
    background: #ff6b6b;
    color: white;
    text-align: center;
    padding: 10px;
    font-weight: bold;
    position: fixed;
    top: 0;
    left: 0;
    right: 0;
    z-index: 9999;
    box-shadow: 0 2px 4px rgba(0,0,0,0.2);
  ">
    🚀 DEMO MODE - This is a demonstration only. Files will not be saved. 🚀
  </div>
`;

const injectDemoBanner = (html) => {
    if (!isDemoMode()) return html;
    return html.replace(
        '<body>',
        '<body>' + getDemoBannerHTML()
    );
};

// Mock storage for demo files and uploads
const demoFiles = new Map();
const demoUploads = new Map();

// Configure demo upload handling
const storage = multer.memoryStorage();
const upload = multer({ storage });

// Create demo routes with exact path matching
const demoRouter = express.Router();

// Mock upload init - match exact path
demoRouter.post('/api/upload/init', (req, res) => {
    const { filename, fileSize } = req.body;
    const uploadId = 'demo-' + Math.random().toString(36).substr(2, 9);
    
    demoUploads.set(uploadId, {
        filename,
        fileSize,
        bytesReceived: 0
    });

    logger.info(`[DEMO] Initialized upload for ${filename} (${fileSize} bytes)`);
    
    return res.json({ uploadId });
});

// Mock chunk upload - match exact path and handle large files
demoRouter.post('/api/upload/chunk/:uploadId', 
    express.raw({ 
        type: 'application/octet-stream',
        limit: config.maxFileSize
    }), 
    (req, res) => {
        const { uploadId } = req.params;
        const upload = demoUploads.get(uploadId);
        
        if (!upload) {
            return res.status(404).json({ error: 'Upload not found' });
        }

        const chunkSize = req.body.length;
        upload.bytesReceived += chunkSize;
        
        // Calculate progress
        const progress = Math.min(
            Math.round((upload.bytesReceived / upload.fileSize) * 100),
            100
        );

        logger.debug(`[DEMO] Chunk received for ${upload.filename}, progress: ${progress}%`);

        // If upload is complete
        if (upload.bytesReceived >= upload.fileSize) {
            const fileId = 'demo-' + Math.random().toString(36).substr(2, 9);
            const mockFile = {
                id: fileId,
                name: upload.filename,
                size: upload.fileSize,
                url: `/api/files/${fileId}`,
                createdAt: new Date().toISOString()
            };
            
            demoFiles.set(fileId, mockFile);
            demoUploads.delete(uploadId);
            
            logger.success(`[DEMO] Upload completed: ${upload.filename} (${upload.fileSize} bytes)`);

            // Return completion response
            return res.json({ 
                bytesReceived: upload.bytesReceived,
                progress,
                complete: true,
                file: mockFile
            });
        }

        return res.json({ 
            bytesReceived: upload.bytesReceived,
            progress
        });
    }
);

// Mock upload cancel - match exact path
demoRouter.post('/api/upload/cancel/:uploadId', (req, res) => {
    const { uploadId } = req.params;
    demoUploads.delete(uploadId);
    logger.info(`[DEMO] Upload cancelled: ${uploadId}`);
    return res.json({ message: 'Upload cancelled' });
});

// Mock file download - match exact path
demoRouter.get('/api/files/:id', (req, res) => {
    const file = demoFiles.get(req.params.id);
    if (!file) {
        return res.status(404).json({
            message: 'Demo Mode: File not found'
        });
    }
    return res.json({
        message: 'Demo Mode: This would download the file in production',
        file
    });
});

// Mock file list - match exact path
demoRouter.get('/api/files', (req, res) => {
    return res.json({
        files: Array.from(demoFiles.values()),
        message: 'Demo Mode: Showing mock file list'
    });
});

// Update middleware to handle errors
const demoMiddleware = (req, res, next) => {
    if (!isDemoMode()) return next();
    
    logger.debug(`[DEMO] Incoming request: ${req.method} ${req.path}`);
    
    // Handle payload too large errors
    demoRouter(req, res, (err) => {
        if (err) {
            logger.error(`[DEMO] Error handling request: ${err.message}`);
            if (err.type === 'entity.too.large') {
                return res.status(413).json({
                    error: 'Payload too large',
                    message: `File size exceeds limit of ${config.maxFileSize} bytes`
                });
            }
            return res.status(500).json({
                error: 'Internal server error',
                message: err.message
            });
        }
        next();
    });
};

module.exports = {
    isDemoMode,
    injectDemoBanner,
    demoMiddleware
}; 