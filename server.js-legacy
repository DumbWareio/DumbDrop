const express = require('express');
const multer = require('multer');
const path = require('path');
const cors = require('cors');
const fs = require('fs');
const crypto = require('crypto');
const cookieParser = require('cookie-parser');
const { exec } = require('child_process');
const util = require('util');
const execAsync = util.promisify(exec);
require('dotenv').config();

// Rate limiting setup
const rateLimit = require('express-rate-limit');

const app = express();
// Add this line to trust the first proxy
app.set('trust proxy', 1);
const port = process.env.PORT || 3000;
const uploadDir = './uploads';  // Local development
const maxFileSize = parseInt(process.env.MAX_FILE_SIZE || '1024') * 1024 * 1024; // Convert MB to bytes
const APPRISE_URL = process.env.APPRISE_URL;
const APPRISE_MESSAGE = process.env.APPRISE_MESSAGE || 'New file uploaded - {filename} ({size}), Storage used {storage}';
const siteTitle = process.env.DUMBDROP_TITLE || 'DumbDrop';
const APPRISE_SIZE_UNIT = process.env.APPRISE_SIZE_UNIT;
const AUTO_UPLOAD = process.env.AUTO_UPLOAD === 'true';

// Update the chunk size and rate limits
const CHUNK_SIZE = 5 * 1024 * 1024; // Increase to 5MB chunks

// Update rate limiters for large files
const initUploadLimiter = rateLimit({
    windowMs: 60 * 1000, // 1 minute window
    max: 30, // 30 new upload initializations per minute
    message: { error: 'Too many upload attempts. Please wait before starting new uploads.' },
    standardHeaders: true,
    legacyHeaders: false
});

// Brute force protection setup
const loginAttempts = new Map();  // Stores IP addresses and their attempt counts
const MAX_ATTEMPTS = 5;           // Maximum allowed attempts
const LOCKOUT_TIME = 15 * 60 * 1000; // 15 minutes in milliseconds

// Reset attempts for an IP
function resetAttempts(ip) {
    loginAttempts.delete(ip);
}

// Check if an IP is locked out
function isLockedOut(ip) {
    const attempts = loginAttempts.get(ip);
    if (!attempts) return false;
    
    if (attempts.count >= MAX_ATTEMPTS) {
        const timeElapsed = Date.now() - attempts.lastAttempt;
        if (timeElapsed < LOCKOUT_TIME) {
            return true;
        }
        resetAttempts(ip);
    }
    return false;
}

// Record an attempt for an IP
function recordAttempt(ip) {
    const attempts = loginAttempts.get(ip) || { count: 0, lastAttempt: 0 };
    attempts.count += 1;
    attempts.lastAttempt = Date.now();
    loginAttempts.set(ip, attempts);
    return attempts;
}

// Cleanup old lockouts every minute
setInterval(() => {
    const now = Date.now();
    for (const [ip, attempts] of loginAttempts.entries()) {
        if (now - attempts.lastAttempt >= LOCKOUT_TIME) {
            loginAttempts.delete(ip);
        }
    }
}, 60000);

// Validate and set PIN
const validatePin = (pin) => {
    if (!pin) return null;
    const cleanPin = pin.replace(/\D/g, '');  // Remove non-digits
    return cleanPin.length >= 4 && cleanPin.length <= 10 ? cleanPin : null;
};
const PIN = validatePin(process.env.DUMBDROP_PIN);

// Logging helper
const log = {
    info: (msg) => console.log(`[INFO] ${new Date().toISOString()} - ${msg}`),
    error: (msg) => console.error(`[ERROR] ${new Date().toISOString()} - ${msg}`),
    success: (msg) => console.log(`[SUCCESS] ${new Date().toISOString()} - ${msg}`)
};

// Helper function to ensure directory exists
async function ensureDirectoryExists(filePath) {
    const dir = path.dirname(filePath);
    try {
        await fs.promises.mkdir(dir, { recursive: true });
    } catch (err) {
        log.error(`Failed to create directory ${dir}: ${err.message}`);
        throw err;
    }
}

// Ensure upload directory exists
try {
    if (!fs.existsSync(uploadDir)) {
        fs.mkdirSync(uploadDir, { recursive: true });
        log.info(`Created upload directory: ${uploadDir}`);
    }
    fs.accessSync(uploadDir, fs.constants.W_OK);
    log.success(`Upload directory is writable: ${uploadDir}`);
    log.info(`Maximum file size set to: ${maxFileSize / (1024 * 1024)}MB`);
    if (PIN) {
        log.info('PIN protection enabled');
    }
} catch (err) {
    log.error(`Directory error: ${err.message}`);
    log.error(`Failed to access or create upload directory: ${uploadDir}`);
    log.error('Please check directory permissions and mounting');
    process.exit(1);
}

// Middleware
app.use(cors());
app.use(cookieParser());
app.use(express.json());

// Security headers middleware
app.use((req, res, next) => {
    // Content Security Policy
    res.setHeader(
        'Content-Security-Policy',
        "default-src 'self'; " +
        "style-src 'self' 'unsafe-inline' cdn.jsdelivr.net; " +
        "script-src 'self' 'unsafe-inline' cdn.jsdelivr.net; " +
        "img-src 'self' data: blob:;"
    );
    // X-Content-Type-Options
    res.setHeader('X-Content-Type-Options', 'nosniff');
    // X-Frame-Options
    res.setHeader('X-Frame-Options', 'SAMEORIGIN');
    // X-XSS-Protection
    res.setHeader('X-XSS-Protection', '1; mode=block');
    // Strict Transport Security (when in production)
    if (process.env.NODE_ENV === 'production') {
        res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
    }
    next();
});

// Helper function for constant-time string comparison
function safeCompare(a, b) {
    if (typeof a !== 'string' || typeof b !== 'string') {
        return false;
    }
    
    // Use Node's built-in constant-time comparison
    return crypto.timingSafeEqual(
        Buffer.from(a.padEnd(32)), 
        Buffer.from(b.padEnd(32))
    );
}

// Pin verification endpoint
app.post('/api/verify-pin', (req, res) => {
    const { pin } = req.body;
    const ip = req.ip;
    
    // If no PIN is set in env, always return success
    if (!PIN) {
        return res.json({ success: true });
    }

    // Check for lockout
    if (isLockedOut(ip)) {
        const attempts = loginAttempts.get(ip);
        const timeLeft = Math.ceil((LOCKOUT_TIME - (Date.now() - attempts.lastAttempt)) / 1000 / 60);
        return res.status(429).json({ 
            error: `Too many attempts. Please try again in ${timeLeft} minutes.`
        });
    }

    // Verify the PIN using constant-time comparison
    if (safeCompare(pin, PIN)) {
        // Reset attempts on successful login
        resetAttempts(ip);
        
        // Set secure cookie
        res.cookie('DUMBDROP_PIN', pin, {
            httpOnly: true,
            secure: process.env.NODE_ENV === 'production',
            sameSite: 'strict',
            path: '/'
        });
        res.json({ success: true });
    } else {
        // Record failed attempt
        const attempts = recordAttempt(ip);
        const attemptsLeft = MAX_ATTEMPTS - attempts.count;
        
        res.status(401).json({ 
            success: false, 
            error: attemptsLeft > 0 ? 
                `Invalid PIN. ${attemptsLeft} attempts remaining.` : 
                'Too many attempts. Account locked for 15 minutes.'
        });
    }
});

// Check if PIN is required
app.get('/api/pin-required', (req, res) => {
    res.json({ 
        required: !!PIN,
        length: PIN ? PIN.length : 0
    });
});

// Pin protection middleware
const requirePin = (req, res, next) => {
    if (!PIN) {
        return next();
    }

    const providedPin = req.headers['x-pin'] || req.cookies.DUMBDROP_PIN;
    if (!safeCompare(providedPin, PIN)) {
        return res.status(401).json({ error: 'Unauthorized' });
    }
    next();
};

// Move the root and login routes before static file serving
app.get('/', (req, res) => {
    if (PIN && !safeCompare(req.cookies.DUMBDROP_PIN, PIN)) {
        return res.redirect('/login.html');
    }
    // Read the file and replace the title
    let html = fs.readFileSync(path.join(__dirname, 'public', 'index.html'), 'utf8');
    html = html.replace(/{{SITE_TITLE}}/g, siteTitle);
    html = html.replace('{{AUTO_UPLOAD}}', AUTO_UPLOAD.toString());
    res.send(html);
});

app.get('/login.html', (req, res) => {
    let html = fs.readFileSync(path.join(__dirname, 'public', 'login.html'), 'utf8');
    html = html.replace(/{{SITE_TITLE}}/g, siteTitle);  // Use global replace
    res.send(html);
});

// Move static file serving after our dynamic routes
app.use(express.static('public'));

// PIN protection middleware should be before the routes that need protection
app.use('/upload', requirePin);

// Store ongoing uploads
const uploads = new Map();
// Store folder name mappings for batch uploads with timestamps
const folderMappings = new Map();
// Store batch IDs for folder uploads
const batchUploads = new Map();
// Store batch activity timestamps
const batchActivity = new Map();

// Add cleanup interval for inactive batches
setInterval(() => {
    const now = Date.now();
    for (const [batchId, lastActivity] of batchActivity.entries()) {
        if (now - lastActivity >= 5 * 60 * 1000) { // 5 minutes of inactivity
            // Clean up all folder mappings for this batch
            for (const key of folderMappings.keys()) {
                if (key.endsWith(`-${batchId}`)) {
                    folderMappings.delete(key);
                }
            }
            batchActivity.delete(batchId);
            log.info(`Cleaned up folder mappings for inactive batch: ${batchId}`);
        }
    }
}, 60000); // Check every minute

// Add these helper functions before the routes
async function getUniqueFilePath(filePath) {
    const dir = path.dirname(filePath);
    const ext = path.extname(filePath);
    const baseName = path.basename(filePath, ext);
    let counter = 1;
    let finalPath = filePath;

    while (true) {
        try {
            // Try to create the file exclusively - will fail if file exists
            const fileHandle = await fs.promises.open(finalPath, 'wx');
            // Return both the path and handle instead of closing it
            return { path: finalPath, handle: fileHandle };
        } catch (err) {
            if (err.code === 'EEXIST') {
                // File exists, try next number
                finalPath = path.join(dir, `${baseName} (${counter})${ext}`);
                counter++;
            } else {
                throw err; // Other errors should be handled by caller
            }
        }
    }
}

async function getUniqueFolderPath(folderPath) {
    let counter = 1;
    let finalPath = folderPath;

    while (true) {
        try {
            // Try to create the directory - mkdir with recursive:false is atomic
            await fs.promises.mkdir(finalPath, { recursive: false });
            return finalPath;
        } catch (err) {
            if (err.code === 'EEXIST') {
                // Folder exists, try next number
                finalPath = `${folderPath} (${counter})`;
                counter++;
            } else if (err.code === 'ENOENT') {
                // Parent directory doesn't exist, create it first
                await fs.promises.mkdir(path.dirname(finalPath), { recursive: true });
                // Then try again with the same path
                continue;
            } else {
                throw err; // Other errors should be handled by caller
            }
        }
    }
}

// Validate batch ID format
function isValidBatchId(batchId) {
    // Batch ID should be in format: timestamp-randomstring
    return /^\d+-[a-z0-9]{9}$/.test(batchId);
}

// Routes
app.post('/upload/init', initUploadLimiter, async (req, res) => {
    const { filename, fileSize } = req.body;
    let batchId = req.headers['x-batch-id'];

    // For single file uploads without a batch ID, generate one
    if (!batchId) {
        const timestamp = Date.now();
        const randomStr = crypto.randomBytes(4).toString('hex').substring(0, 9);
        batchId = `${timestamp}-${randomStr}`;
    } else if (!isValidBatchId(batchId)) {
        log.error('Invalid batch ID format');
        return res.status(400).json({ error: 'Invalid batch ID format' });
    }

    // Always update batch activity timestamp for any upload
    batchActivity.set(batchId, Date.now());

    const safeFilename = path.normalize(filename).replace(/^(\.\.(\/|\\|$))+/, '');
    
    // Validate file extension
    const allowedExtensions = process.env.ALLOWED_EXTENSIONS ? 
        process.env.ALLOWED_EXTENSIONS.split(',').map(ext => ext.trim().toLowerCase()) : 
        null;
    
    if (allowedExtensions) {
        const fileExt = path.extname(safeFilename).toLowerCase();
        if (!allowedExtensions.includes(fileExt)) {
            log.error(`File type ${fileExt} not allowed`);
            return res.status(400).json({ 
                error: 'File type not allowed',
                allowedExtensions
            });
        }
    }
    
    // Check file size limit
    if (fileSize > maxFileSize) {
        log.error(`File size ${fileSize} bytes exceeds limit of ${maxFileSize} bytes`);
        return res.status(413).json({ 
            error: 'File too large',
            limit: maxFileSize,
            limitInMB: maxFileSize / (1024 * 1024)
        });
    }

    const uploadId = crypto.randomBytes(16).toString('hex');
    let filePath = path.join(uploadDir, safeFilename);
    let fileHandle;
    
    try {
        // Handle file/folder duplication
        const pathParts = safeFilename.split('/');
        
        if (pathParts.length > 1) {
            // This is a file within a folder
            const originalFolderName = pathParts[0];
            const folderPath = path.join(uploadDir, originalFolderName);

            // Check if we already have a mapping for this folder in this batch
            let newFolderName = folderMappings.get(`${originalFolderName}-${batchId}`);
            
            if (!newFolderName) {
                try {
                    // Try to create the folder atomically first
                    await fs.promises.mkdir(folderPath, { recursive: false });
                    newFolderName = originalFolderName;
                } catch (err) {
                    if (err.code === 'EEXIST') {
                        // Folder exists, get a unique name
                        const uniqueFolderPath = await getUniqueFolderPath(folderPath);
                        newFolderName = path.basename(uniqueFolderPath);
                        log.info(`Folder "${originalFolderName}" exists, using "${newFolderName}" instead`);
                    } else {
                        throw err;
                    }
                }
                
                folderMappings.set(`${originalFolderName}-${batchId}`, newFolderName);
            }

            // Replace the original folder path with the mapped one and keep original file name
            pathParts[0] = newFolderName;
            filePath = path.join(uploadDir, ...pathParts);
            
            // Ensure parent directories exist
            await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
        }

        // For both single files and files in folders, get a unique path and file handle
        const result = await getUniqueFilePath(filePath);
        filePath = result.path;
        fileHandle = result.handle;
        
        // Create upload entry (using the file handle we already have)
        uploads.set(uploadId, {
            safeFilename: path.relative(uploadDir, filePath),
            filePath,
            fileSize,
            bytesReceived: 0,
            writeStream: fileHandle.createWriteStream()
        });

        log.info(`Initialized upload for ${path.relative(uploadDir, filePath)} (${fileSize} bytes)`);
        res.json({ uploadId });
    } catch (err) {
        // Clean up file handle if something went wrong
        if (fileHandle) {
            await fileHandle.close().catch(() => {});
            // Try to remove the file if it was created
            fs.unlink(filePath).catch(() => {});
        }
        log.error(`Failed to initialize upload: ${err.message}`);
        res.status(500).json({ error: 'Failed to initialize upload' });
    }
});

app.post('/upload/chunk/:uploadId', express.raw({ 
    limit: '10mb', 
    type: 'application/octet-stream' 
}), async (req, res) => {
    const { uploadId } = req.params;
    const upload = uploads.get(uploadId);
    const chunkSize = req.body.length;

    if (!upload) {
        return res.status(404).json({ error: 'Upload not found' });
    }

    try {
        // Get the batch ID from the request headers
        const batchId = req.headers['x-batch-id'];
        if (batchId && isValidBatchId(batchId)) {
            // Update batch activity timestamp
            batchActivity.set(batchId, Date.now());
        }

        upload.writeStream.write(Buffer.from(req.body));
        upload.bytesReceived += chunkSize;

        const progress = Math.round((upload.bytesReceived / upload.fileSize) * 100);
        log.info(`Received chunk for ${upload.safeFilename}: ${progress}%`);

        res.json({ 
            bytesReceived: upload.bytesReceived,
            progress
        });

        // Check if upload is complete
        if (upload.bytesReceived >= upload.fileSize) {
            upload.writeStream.end();
            uploads.delete(uploadId);
            log.success(`Upload completed: ${upload.safeFilename}`);
            
            // Update notification call to use safeFilename
            await sendNotification(upload.safeFilename, upload.fileSize);
        }
    } catch (err) {
        log.error(`Chunk upload failed: ${err.message}`);
        res.status(500).json({ error: 'Failed to process chunk' });
    }
});

app.post('/upload/cancel/:uploadId', (req, res) => {
    const { uploadId } = req.params;
    const upload = uploads.get(uploadId);

    if (upload) {
        upload.writeStream.end();
        fs.unlink(upload.filePath, (err) => {
            if (err) log.error(`Failed to delete incomplete upload: ${err.message}`);
        });
        uploads.delete(uploadId);
        log.info(`Upload cancelled: ${upload.safeFilename}`);
    }

    res.json({ message: 'Upload cancelled' });
});

// Error handling middleware
app.use((err, req, res, next) => {
    log.error(`Unhandled error: ${err.message}`);
    res.status(500).json({ message: 'Internal server error', error: err.message });
});

// Start server
app.listen(port, () => {
    log.info(`Server running at http://localhost:${port}`);
    log.info(`Upload directory: ${uploadDir}`);
    
    // Log custom title if set
    if (process.env.DUMBDROP_TITLE) {
        log.info(`Custom title set to: ${siteTitle}`);
    }
    
    // Add auto upload status logging
    log.info(`Auto upload is ${AUTO_UPLOAD ? 'enabled' : 'disabled'}`);
    
    // Add Apprise configuration logging
    if (APPRISE_URL) {
        log.info('Apprise notifications enabled');
    } else {
        log.info('Apprise notifications disabled - no URL configured');
    }
    
    // List directory contents
    try {
        const files = fs.readdirSync(uploadDir);
        log.info(`Current directory contents (${files.length} files):`);
        files.forEach(file => {
            log.info(`- ${file}`);
        });
    } catch (err) {
        log.error(`Failed to list directory contents: ${err.message}`);
    }
});

// Remove async from formatFileSize function
function formatFileSize(bytes) {
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    let size = bytes;
    let unitIndex = 0;

    // If a specific unit is requested
    if (APPRISE_SIZE_UNIT) {
        const requestedUnit = APPRISE_SIZE_UNIT.toUpperCase();
        const unitIndex = units.indexOf(requestedUnit);
        if (unitIndex !== -1) {
            size = bytes / Math.pow(1024, unitIndex);
            return size.toFixed(2) + requestedUnit;
        }
    }

    // Auto format to nearest unit
    while (size >= 1024 && unitIndex < units.length - 1) {
        size /= 1024;
        unitIndex++;
    }

    // Round to 2 decimal places
    return size.toFixed(2) + units[unitIndex];
}

// Add this helper function
function calculateDirectorySize(directoryPath) {
    let totalSize = 0;
    const files = fs.readdirSync(directoryPath);
    
    files.forEach(file => {
        const filePath = path.join(directoryPath, file);
        const stats = fs.statSync(filePath);
        if (stats.isFile()) {
            totalSize += stats.size;
        }
    });
    
    return totalSize;
}

// Modify the sendNotification function to safely escape the message
async function sendNotification(filename, fileSize) {
    if (!APPRISE_URL) return;

    try {
        const formattedSize = formatFileSize(fileSize);
        const totalStorage = formatFileSize(calculateDirectorySize(uploadDir));
        
        // Sanitize the message components
        const sanitizedFilename = JSON.stringify(filename).slice(1, -1); // Escape special characters
        const message = APPRISE_MESSAGE
            .replace('{filename}', sanitizedFilename)
            .replace('{size}', formattedSize)
            .replace('{storage}', totalStorage);

        // Use a string command instead of an array
        const command = `apprise ${APPRISE_URL} -b "${message}"`;
        await execAsync(command, {
            shell: true
        });
        
        log.info(`Notification sent for: ${sanitizedFilename} (${formattedSize}, Total storage: ${totalStorage})`);
    } catch (err) {
        log.error(`Failed to send notification: ${err.message}`);
    }
}
