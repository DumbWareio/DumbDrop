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
const { S3Client } = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
const { PutObjectCommand, HeadObjectCommand, ListObjectsV2Command, CreateMultipartUploadCommand, UploadPartCommand, CompleteMultipartUploadCommand, AbortMultipartUploadCommand } = require('@aws-sdk/client-s3');
const { NodeHttpHandler } = require('@aws-sdk/node-http-handler');

// Rate limiting setup
const rateLimit = require('express-rate-limit');

const app = express();
// Add this line to trust the first proxy
app.set('trust proxy', 1);
const port = process.env.PORT || 3000;

// Logging helper
const log = {
    info: (msg) => console.log(`[INFO] ${new Date().toISOString()} - ${msg}`),
    error: (msg) => console.error(`[ERROR] ${new Date().toISOString()} - ${msg}`),
    success: (msg) => console.log(`[SUCCESS] ${new Date().toISOString()} - ${msg}`)
};

// Storage configuration
const storageType = process.env.DUMBDROP_STORAGE || 'local';
if (storageType !== 'local' && storageType !== 's3') {
    log.error(`Unsupported storage type: ${storageType}. Defaulting to 'local'`);
}
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
    // Build connect-src directive based on storage type
    let connectSrc = "'self'";
    if (process.env.DUMBDROP_STORAGE === 's3' && process.env.DUMBDROP_S3_ENDPOINT) {
        connectSrc += ` ${process.env.DUMBDROP_S3_ENDPOINT}`;
    }

    // Content Security Policy
    res.setHeader(
        'Content-Security-Policy',
        "default-src 'self'; " +
        "style-src 'self' 'unsafe-inline' cdn.jsdelivr.net; " +
        "script-src 'self' 'unsafe-inline' cdn.jsdelivr.net; " +
        "img-src 'self' data: blob:; " +
        `connect-src ${connectSrc}`
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
            // Clean up S3 folder mappings for this batch
            for (const key of s3FolderMappings.keys()) {
                if (key.endsWith(`-${batchId}`)) {
                    s3FolderMappings.delete(key);
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

let s3Client;
if (process.env.DUMBDROP_STORAGE === 's3') {
    (async () => {
        try {
            // Validate required S3 configuration
            const requiredS3Config = [
                'DUMBDROP_S3_REGION',
                'DUMBDROP_S3_ENDPOINT',
                'DUMBDROP_S3_KEY',
                'DUMBDROP_S3_SECRET',
                'DUMBDROP_S3_BUCKET'
            ];

            const missingConfig = requiredS3Config.filter(key => !process.env[key]);
            if (missingConfig.length > 0) {
                throw new Error(`Missing required S3 configuration: ${missingConfig.join(', ')}`);
            }

            // Parse endpoint URL to determine if it's HTTP/HTTPS
            const endpointUrl = new URL(process.env.DUMBDROP_S3_ENDPOINT);
            const useSSL = endpointUrl.protocol === 'https:';

    s3Client = new S3Client({
        region: process.env.DUMBDROP_S3_REGION,
        endpoint: process.env.DUMBDROP_S3_ENDPOINT,
        credentials: {
            accessKeyId: process.env.DUMBDROP_S3_KEY,
            secretAccessKey: process.env.DUMBDROP_S3_SECRET,
        },
                forcePathStyle: true, // Required for MinIO
                signingRegion: process.env.DUMBDROP_S3_REGION,
                maxAttempts: 3,
                tls: useSSL,
                // Disable AWS specific features
                useAccelerateEndpoint: false,
                useDualstackEndpoint: false,
                useFipsEndpoint: false,
                retryMode: 'standard',
                requestHandler: new NodeHttpHandler({
                    connectionTimeout: 5000,
                    socketTimeout: 5000,
                    // Add these headers for Cloudflare
                    headers: {
                        'Host': new URL(process.env.DUMBDROP_S3_ENDPOINT).hostname
                    }
                }),
                // Add this for presigned URLs through Cloudflare
                customUserAgent: 'MinIO (DumbDrop)'
            });

            // Test S3 connection and permissions with more detailed error logging
            log.info('Testing S3 connection and permissions...');
            log.info(`Using endpoint: ${process.env.DUMBDROP_S3_ENDPOINT}`);
            log.info(`Using bucket: ${process.env.DUMBDROP_S3_BUCKET}`);
            log.info(`Using region: ${process.env.DUMBDROP_S3_REGION}`);
            log.info(`Using access key: ${process.env.DUMBDROP_S3_KEY}`);
            log.info(`Using SSL: ${useSSL}`);
            
            // Try to perform basic operations
            const testOps = async () => {
                try {
                    // First, try a simple list operation to check bucket access
                    try {
                        log.info('Testing ListObjectsV2 operation...');
                        const listCommand = new ListObjectsV2Command({
                            Bucket: process.env.DUMBDROP_S3_BUCKET,
                            MaxKeys: 1
                        });
                        log.info('Sending ListObjectsV2 command...');
                        const listResponse = await s3Client.send(listCommand);
                        log.success('Successfully listed bucket contents');
                        log.info(`List response metadata: ${JSON.stringify(listResponse.$metadata, null, 2)}`);
                        log.info(`List response contents: ${JSON.stringify(listResponse.Contents, null, 2)}`);
                    } catch (listErr) {
                        log.error(`List operation failed: ${listErr.message}`);
                        log.error(`Error name: ${listErr.name}`);
                        log.error(`Error stack: ${listErr.stack}`);
                        if (listErr.$metadata) {
                            log.error(`List error metadata: ${JSON.stringify(listErr.$metadata, null, 2)}`);
                        }
                        // Try to get more error details
                        if (listErr.Code) log.error(`Error code: ${listErr.Code}`);
                        if (listErr.Region) log.error(`Error region: ${listErr.Region}`);
                        if (listErr.hostname) log.error(`Error hostname: ${listErr.hostname}`);
                        throw listErr;
                    }

                    // Test S3 permissions first with a HEAD request
                    try {
                        log.info('Testing HEAD request for permissions check...');
                        const testKey = `test-permissions-${Date.now()}.txt`;
                        log.info(`Testing GetObject permissions for key: ${testKey}`);
                        
                        // First try to put a test object
                        const putCommand = new PutObjectCommand({
                            Bucket: process.env.DUMBDROP_S3_BUCKET,
                            Key: testKey,
                            Body: 'test'
                        });
                        await s3Client.send(putCommand);
                        log.info('Successfully put test object');

                        // Then try to get it
                        const getCommand = new HeadObjectCommand({
                            Bucket: process.env.DUMBDROP_S3_BUCKET,
                            Key: testKey
                        });
                        log.info(`Sending HeadObject command for key: ${testKey}`);
                        log.info(`Command parameters: ${JSON.stringify(getCommand.input, null, 2)}`);
                        
                        await s3Client.send(getCommand);
                        log.success('Successfully verified GetObject permissions');
                    } catch (err) {
                        if (err.name !== 'NotFound') {
                            // If error is not NotFound, we might have a permissions issue
                            log.error(`S3 permissions test failed: ${err.name} - ${err.message}`);
                            log.error(`Error details: ${JSON.stringify({
                                code: err.Code,
                                name: err.name,
                                message: err.message,
                                region: err.Region,
                                hostname: err.hostname,
                                metadata: err.$metadata,
                                requestId: err.$metadata?.requestId,
                                httpStatusCode: err.$metadata?.httpStatusCode
                            }, null, 2)}`);
                            throw new Error(`S3 permissions error: ${err.message}`);
                        }
                        log.info('HEAD request returned NotFound as expected');
                    }

                    // Try a simple PUT operation
                    try {
                        log.info('Testing PutObject operation...');
                        const testKey = `test-permissions-${Date.now()}.txt`;
                        const putCommand = new PutObjectCommand({
                            Bucket: process.env.DUMBDROP_S3_BUCKET,
                            Key: testKey,
                            Body: 'test',
                            ContentType: 'text/plain'
                        });
                        
                        log.info('Sending PutObject command...');
                        const putResponse = await s3Client.send(putCommand);
                        log.success('Successfully put test object');
                        log.info(`Put response metadata: ${JSON.stringify(putResponse.$metadata, null, 2)}`);

                        // Test multipart upload operations
                        try {
                            log.info('Testing CreateMultipartUpload operation...');
                            const testKey = `test-multipart-${Date.now()}.txt`;
                            const createCommand = new CreateMultipartUploadCommand({
                                Bucket: process.env.DUMBDROP_S3_BUCKET,
                                Key: testKey,
                                ContentType: 'text/plain'
                            });
                            
                            log.info('Sending CreateMultipartUpload command...');
                            const { UploadId } = await s3Client.send(createCommand);
                            log.success(`Successfully initialized multipart upload with ID: ${UploadId}`);

                            // Try to upload a part
                            log.info('Testing UploadPart operation...');
                            const partCommand = new UploadPartCommand({
                                Bucket: process.env.DUMBDROP_S3_BUCKET,
                                Key: testKey,
                                UploadId,
                                PartNumber: 1
                            });

                            log.info('Sending UploadPart command...');
                            const partResponse = await s3Client.send(partCommand);
                            log.success('Successfully uploaded part');
                            log.info(`Part response metadata: ${JSON.stringify(partResponse.$metadata, null, 2)}`);
                            const partETag = partResponse.ETag;

                            // Try to complete the multipart upload
                            log.info('Testing CompleteMultipartUpload operation...');
                            const completeCommand = new CompleteMultipartUploadCommand({
                                Bucket: process.env.DUMBDROP_S3_BUCKET,
                                Key: testKey,
                                UploadId,
                                MultipartUpload: {
                                    Parts: [
                                        {
                                            PartNumber: 1,
                                            ETag: partETag
                                        }
                                    ]
                                }
                            });

                            log.info('Sending CompleteMultipartUpload command...');
                            const completeResponse = await s3Client.send(completeCommand);
                            log.success('Successfully completed multipart upload');
                            log.info(`Complete response metadata: ${JSON.stringify(completeResponse.$metadata, null, 2)}`);
                        } catch (multipartErr) {
                            log.error(`Multipart operations failed: ${multipartErr.message}`);
                            log.error(`Error name: ${multipartErr.name}`);
                            log.error(`Error stack: ${multipartErr.stack}`);
                            if (multipartErr.$metadata) {
                                log.error(`Multipart error metadata: ${JSON.stringify(multipartErr.$metadata, null, 2)}`);
                            }
                            // Try to get more error details
                            if (multipartErr.Code) log.error(`Error code: ${multipartErr.Code}`);
                            if (multipartErr.Region) log.error(`Error region: ${multipartErr.Region}`);
                            if (multipartErr.hostname) log.error(`Error hostname: ${multipartErr.hostname}`);
                            throw multipartErr;
                        }

                        log.success('All S3 operations test passed');
                        return true;
                    } catch (putErr) {
                        log.error(`Put operation failed: ${putErr.message}`);
                        log.error(`Error name: ${putErr.name}`);
                        log.error(`Error stack: ${putErr.stack}`);
                        if (putErr.$metadata) {
                            log.error(`Put error metadata: ${JSON.stringify(putErr.$metadata, null, 2)}`);
                        }
                        // Try to get more error details
                        if (putErr.Code) log.error(`Error code: ${putErr.Code}`);
                        if (putErr.Region) log.error(`Error region: ${putErr.Region}`);
                        if (putErr.hostname) log.error(`Error hostname: ${putErr.hostname}`);
                        throw putErr;
                    }

                    log.success('Basic S3 operations test passed');
                    return true;
                } catch (err) {
                    const errorDetails = {
                        code: err.name,
                        message: err.message,
                        stack: err.stack,
                        requestId: err.$metadata?.requestId,
                        httpStatus: err.$metadata?.httpStatusCode,
                        endpoint: process.env.DUMBDROP_S3_ENDPOINT,
                        region: process.env.DUMBDROP_S3_REGION,
                        bucket: process.env.DUMBDROP_S3_BUCKET
                    };
                    log.error(`S3 permissions test failed: ${JSON.stringify(errorDetails, null, 2)}`);
                    return false;
                }
            };

            const testResult = await testOps();
            if (!testResult) {
                throw new Error('Failed to verify S3 permissions. Please check your bucket policy and IAM permissions.');
            }

        } catch (err) {
            log.error(`Failed to initialize S3 client: ${err.message}`);
            if (err.$metadata) {
                log.error(`S3 error metadata: ${JSON.stringify(err.$metadata)}`);
            }
            process.exit(1);
        }
    })();
}

// Add validation helper functions
function validateFileSize(size) {
    if (size > maxFileSize) {
        const error = new Error('File too large');
        error.code = 'FILE_TOO_LARGE';
        error.details = {
            limit: maxFileSize,
            limitInMB: maxFileSize / (1024 * 1024)
        };
        throw error;
    }
}

function validateFileExtension(filename) {
    const allowedExtensions = process.env.ALLOWED_EXTENSIONS ? 
        process.env.ALLOWED_EXTENSIONS.split(',').map(ext => ext.trim().toLowerCase()) : 
        null;
    
    if (allowedExtensions) {
        const fileExt = path.extname(filename).toLowerCase();
        if (!allowedExtensions.includes(fileExt)) {
            const error = new Error('File type not allowed');
            error.code = 'INVALID_FILE_TYPE';
            error.details = { allowedExtensions };
            throw error;
        }
    }
}

function sanitizeFilename(filename) {
    // Normalize the path and remove any path traversal attempts
    const normalizedPath = path.normalize(filename).replace(/^(\.\.(\/|\\|$))+/, '');
    
    // Split into directory path and filename
    const parts = normalizedPath.split(/[/\\]/);
    const sanitizedParts = parts.map(part => {
        // Remove any dangerous characters from each part
        return part.replace(/[<>:"|?*\x00-\x1F]/g, '_');
    });
    
    return sanitizedParts.join('/');
}

// Add S3 folder mapping to maintain folder consistency within batches
const s3FolderMappings = new Map();

// Add S3 folder handling function
async function getUniqueS3FolderPath(s3Client, bucket, folderPath, batchId) {
    // Check if we already have a mapping for this folder in this batch
    const mappingKey = `${folderPath}-${batchId}`;
    if (s3FolderMappings.has(mappingKey)) {
        return s3FolderMappings.get(mappingKey);
    }

    let counter = 1;
    let finalPath = folderPath;

    while (true) {
        try {
            // Check if any objects exist with this folder prefix
            const response = await s3Client.send(new ListObjectsV2Command({
                Bucket: bucket,
                Prefix: finalPath + '/',
                MaxKeys: 1
            }));

            if (!response.Contents || response.Contents.length === 0) {
                // No objects with this prefix exist, we can use this folder path
                s3FolderMappings.set(mappingKey, finalPath);
                return finalPath;
            }

            // Folder exists, try next number
            finalPath = `${folderPath} (${counter})`;
            counter++;
        } catch (err) {
            throw err;
        }
    }
}

// Update getUniqueS3Key to handle folders with batch context
async function getUniqueS3Key(s3Client, bucket, key, batchId) {
    log.info(`getUniqueS3Key: Starting for key ${key}`);
    // Split the path into directory and filename
    const parts = key.split('/');
    const filename = parts.pop();
    let folderPath = parts.join('/');

    log.info(`getUniqueS3Key: Parsed path - filename: ${filename}, folderPath: ${folderPath}`);

    // If there's no folder path, generate a unique key with timestamp
    if (!folderPath) {
        log.info('getUniqueS3Key: No folder path, generating unique key');
        const timestamp = Date.now();
        const uniqueKey = `${timestamp}-${filename}`;
        log.info(`getUniqueS3Key: Generated unique key: ${uniqueKey}`);
        return uniqueKey;
    }

    // Get unique folder path if needed (now with batch context)
    log.info(`getUniqueS3Key: Getting unique folder path for ${folderPath}`);
    const uniqueFolderPath = await getUniqueS3FolderPath(s3Client, bucket, folderPath, batchId);
    log.info(`getUniqueS3Key: Got unique folder path: ${uniqueFolderPath}`);
    
    // Return the complete path with timestamp and filename
    const timestamp = Date.now();
    const finalPath = `${uniqueFolderPath}/${timestamp}-${filename}`;
    log.info(`getUniqueS3Key: Final path: ${finalPath}`);
    return finalPath;
}

// Helper function to check individual file existence
async function checkS3ObjectExists(s3Client, bucket, key) {
    log.info(`checkS3ObjectExists: Checking existence of ${key} in bucket ${bucket}`);
    const ext = path.extname(key);
    const baseName = key.slice(0, -ext.length);
    let counter = 1;
    let finalKey = key;

    while (true) {
        try {
            log.info(`checkS3ObjectExists: Trying HEAD request for ${finalKey}`);
            await s3Client.send(new HeadObjectCommand({
                Bucket: bucket,
                Key: finalKey
            }));
            // Single file exists, try next number
            log.info(`checkS3ObjectExists: File exists, trying next number`);
            finalKey = `${baseName} (${counter})${ext}`;
            counter++;
        } catch (err) {
            if (err.name === 'NotFound') {
                log.info(`checkS3ObjectExists: File does not exist, can use key: ${finalKey}`);
                return finalKey;
            }
            log.error(`checkS3ObjectExists: Error checking file existence: ${err.name} - ${err.message}`);
            log.error(`Error details: ${JSON.stringify({
                code: err.Code,
                name: err.name,
                message: err.message,
                region: err.Region,
                hostname: err.hostname,
                metadata: err.$metadata
            }, null, 2)}`);
            throw err;
        }
    }
}

// Routes
app.post('/upload/init', initUploadLimiter, async (req, res) => {
    const { filename, fileSize } = req.body;
    let batchId = req.headers['x-batch-id'];

    log.info(`Initializing upload for file: ${filename}, size: ${fileSize}, batchId: ${batchId}`);

    if (!filename || typeof fileSize !== 'number') {
        return res.status(400).json({ error: 'Invalid request parameters' });
    }

    try {
        // Validate file size and extension
        validateFileSize(fileSize);
        validateFileExtension(filename);

        // Sanitize the filename
        const safeFilename = sanitizeFilename(filename);
        const uploadId = crypto.randomBytes(16).toString('hex');

        // For single file uploads without a batch ID, generate one
        if (!batchId) {
            const timestamp = Date.now();
            const randomStr = crypto.randomBytes(4).toString('hex').substring(0, 9);
            batchId = `${timestamp}-${randomStr}`;
        } else if (!isValidBatchId(batchId)) {
            return res.status(400).json({ error: 'Invalid batch ID format' });
        }

        // Always update batch activity timestamp for any upload
        batchActivity.set(batchId, Date.now());

        if (process.env.DUMBDROP_STORAGE === 's3') {
            try {
                log.info('Using S3 storage for upload');
                log.info(`S3 Configuration:
                    Endpoint: ${process.env.DUMBDROP_S3_ENDPOINT}
                    Bucket: ${process.env.DUMBDROP_S3_BUCKET}
                    Region: ${process.env.DUMBDROP_S3_REGION}
                    Key ID: ${process.env.DUMBDROP_S3_KEY}`);

                // Test S3 permissions first with a HEAD request
                try {
                    log.info('Testing HEAD request for permissions check...');
                    const testKey = `test-permissions-${Date.now()}.txt`;
                    log.info(`Testing GetObject permissions for key: ${testKey}`);
                    
                    // First try to put a test object
                    const putCommand = new PutObjectCommand({
                        Bucket: process.env.DUMBDROP_S3_BUCKET,
                        Key: testKey,
                        Body: 'test'
                    });
                    await s3Client.send(putCommand);
                    log.info('Successfully put test object');

                    // Then try to get it
                    const getCommand = new HeadObjectCommand({
                        Bucket: process.env.DUMBDROP_S3_BUCKET,
                        Key: testKey
                    });
                    log.info(`Sending HeadObject command for key: ${testKey}`);
                    log.info(`Command parameters: ${JSON.stringify(getCommand.input, null, 2)}`);
                    
                    await s3Client.send(getCommand);
                    log.success('Successfully verified GetObject permissions');
                } catch (err) {
                    if (err.name !== 'NotFound') {
                        // If error is not NotFound, we might have a permissions issue
                        log.error(`S3 permissions test failed: ${err.name} - ${err.message}`);
                        log.error(`Error details: ${JSON.stringify({
                            code: err.Code,
                            name: err.name,
                            message: err.message,
                            region: err.Region,
                            hostname: err.hostname,
                            metadata: err.$metadata,
                            requestId: err.$metadata?.requestId,
                            httpStatusCode: err.$metadata?.httpStatusCode
                        }, null, 2)}`);
                        throw new Error(`S3 permissions error: ${err.message}`);
                    }
                    log.info('HEAD request returned NotFound as expected');
                }

            // Get unique S3 key (now with batch context)
                log.info(`Generating unique key for file: ${safeFilename}`);
            const uniqueKey = await getUniqueS3Key(s3Client, process.env.DUMBDROP_S3_BUCKET, safeFilename, batchId);
                log.info(`Generated unique key: ${uniqueKey}`);
                
                // For large files (> 5MB), use multipart upload
                if (fileSize > 5 * 1024 * 1024) {
                    try {
                        log.info('Initializing multipart upload...');
                        log.info(`File size: ${fileSize} bytes (${(fileSize / (1024 * 1024)).toFixed(2)} MB)`);
                        log.info(`Unique key for multipart upload: ${uniqueKey}`);
                        
                        // Calculate optimal part size to ensure each part meets minimum size requirements
                        const minPartSize = 5 * 1024 * 1024; // 5MB minimum
                        const maxParts = Math.ceil(fileSize / minPartSize);
                        const partSize = Math.max(minPartSize, Math.ceil(fileSize / maxParts));
                        const numParts = Math.ceil(fileSize / partSize);
                        
                        log.info(`Using part size: ${(partSize / (1024 * 1024)).toFixed(2)}MB for ${numParts} parts`);

                        const createCommand = {
                            Bucket: process.env.DUMBDROP_S3_BUCKET,
                            Key: uniqueKey,
                            ContentType: 'application/octet-stream'
                        };
                        log.info(`CreateMultipartUpload command params: ${JSON.stringify(createCommand, null, 2)}`);

                        // Create multipart upload
                        const createMultipartUpload = new CreateMultipartUploadCommand(createCommand);
                        log.info('Sending CreateMultipartUpload command...');
                        const { UploadId } = await s3Client.send(createMultipartUpload);
                        log.success(`Received UploadId: ${UploadId}`);

                        // Generate presigned URLs for each part
                        log.info('Generating presigned URLs for parts...');
                        const partUrls = await Promise.all(
                            Array.from({ length: numParts }, async (_, index) => {
                                const partNumber = index + 1;
                                log.info(`Generating presigned URL for part ${partNumber}/${numParts}`);
                                
                                const command = new UploadPartCommand({
                                    Bucket: process.env.DUMBDROP_S3_BUCKET,
                                    Key: uniqueKey,
                                    UploadId,
                                    PartNumber: partNumber
                                });
                                log.info(`UploadPart command params for part ${partNumber}: ${JSON.stringify(command.input, null, 2)}`);

                                try {
                                    const signedUrl = await getSignedUrl(s3Client, command, {
                                        expiresIn: 3600,
                                        // Include Content-Type in signable headers
                                        signableHeaders: new Set(['host', 'content-type']),
                                        // Remove any checksum-related parameters
                                        unhoistableHeaders: new Set(['x-amz-checksum-crc32', 'x-amz-sdk-checksum-algorithm']),
                                        unsignableHeaders: new Set(['x-amz-checksum-crc32', 'x-amz-sdk-checksum-algorithm'])
                                    });
                                    log.success(`Successfully generated presigned URL for part ${partNumber}`);
                                    log.info(`Part ${partNumber} URL length: ${signedUrl.length} chars`);
                                    
                                    return {
                                        url: signedUrl,
                                        partNumber: partNumber,
                                        size: Math.min(partSize, fileSize - (index * partSize))
                                    };
                                } catch (presignError) {
                                    log.error(`Failed to generate presigned URL for part ${partNumber}`);
                                    log.error(`Presign error: ${presignError.name} - ${presignError.message}`);
                                    log.error(`Error details: ${JSON.stringify({
                                        code: presignError.Code,
                                        name: presignError.name,
                                        message: presignError.message,
                                        region: presignError.Region,
                                        hostname: presignError.hostname,
                                        metadata: presignError.$metadata,
                                        requestId: presignError.$metadata?.requestId,
                                        httpStatusCode: presignError.$metadata?.httpStatusCode
                                    }, null, 2)}`);
                                    throw presignError;
                                }
                            })
                        );

                        log.success(`Successfully generated ${partUrls.length} presigned URLs`);
                        log.info(`First part URL sample (truncated): ${partUrls[0].url.substring(0, 100)}...`);
                        
                        res.json({
                            uploadId,
                            s3UploadId: UploadId,
                            parts: partUrls,
                            key: uniqueKey,
                            isMultipart: true
                        });
                    } catch (multipartError) {
                        log.error(`Multipart upload initialization failed: ${multipartError.name} - ${multipartError.message}`);
                        log.error(`Error stack: ${multipartError.stack}`);
                        if (multipartError.$metadata) {
                            log.error(`S3 error metadata: ${JSON.stringify(multipartError.$metadata, null, 2)}`);
                        }
                        throw multipartError;
                    }
                } else {
                    // For small files, use single PUT
            const command = new PutObjectCommand({
                Bucket: process.env.DUMBDROP_S3_BUCKET,
                Key: uniqueKey,
                ContentType: 'application/octet-stream'
                        // Remove ACL for better compatibility
                    });

                    log.info('Generating presigned URL for single PUT...');
                    const uploadUrl = await getSignedUrl(s3Client, command, { 
                        expiresIn: 3600,
                        signableHeaders: new Set(['host'])
                    });
                    log.info(`Generated presigned URL: ${uploadUrl}`);

                    log.info(`Generated presigned URL for ${uniqueKey}`);
                    
            res.json({ 
                uploadId, 
                uploadUrl,
                        key: uniqueKey,
                        isMultipart: false
                    });
                }
            } catch (s3Error) {
                // Enhanced error logging with specific error types
                log.error(`S3 operation failed: ${s3Error.name} - ${s3Error.message}`);
                if (s3Error.$metadata) {
                    log.error(`S3 error metadata: ${JSON.stringify(s3Error.$metadata)}`);
                }
                
                let errorMessage = 'Failed to initialize S3 upload';
                let statusCode = 500;
                
                // Map common S3 errors to user-friendly messages
                if (s3Error.name === 'NoSuchBucket') {
                    errorMessage = 'The specified S3 bucket does not exist';
                    statusCode = 400;
                } else if (s3Error.$metadata?.httpStatusCode === 403) {
                    errorMessage = 'Permission denied. Please check S3 bucket permissions';
                    statusCode = 403;
                } else if (s3Error.name === 'InvalidAccessKeyId') {
                    errorMessage = 'Invalid S3 credentials';
                    statusCode = 401;
                }
                
                return res.status(statusCode).json({
                    error: errorMessage,
                    details: {
                        message: s3Error.message,
                        code: s3Error.code || s3Error.name,
                        requestId: s3Error.$metadata?.requestId
                    }
                });
            }
        } else {
            // Local storage logic
            const filePath = path.join(uploadDir, safeFilename);
            
            // Ensure parent directories exist
            await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
            
            // Get unique file path to prevent overwrites
            const { path: uniquePath, handle } = await getUniqueFilePath(filePath);
            
            // Create upload entry
            uploads.set(uploadId, {
                safeFilename: path.relative(uploadDir, uniquePath),
                filePath: uniquePath,
                fileSize,
                bytesReceived: 0,
                writeStream: handle.createWriteStream()
            });

            res.json({ uploadId, filePath: uniquePath });
        }
    } catch (err) {
        log.error(`Failed to initialize upload: ${err.message}`);
        
        if (err.code === 'FILE_TOO_LARGE') {
            return res.status(413).json({
                error: 'File too large',
                ...err.details
            });
        } else if (err.code === 'INVALID_FILE_TYPE') {
            return res.status(400).json({
                error: 'File type not allowed',
                ...err.details
            });
        }
        
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

// Add this route after the other upload routes
app.post('/upload/complete/:uploadId', async (req, res) => {
    const { key, uploadId: s3UploadId, parts } = req.body;

    log.info(`Completing multipart upload for key: ${key}`);
    log.info(`Upload ID: ${s3UploadId}`);
    log.info(`Number of parts to complete: ${parts.length}`);
    log.info(`Parts data: ${JSON.stringify(parts, null, 2)}`);

    if (!key || !s3UploadId || !parts || !Array.isArray(parts)) {
        log.error('Invalid completion parameters received');
        log.error(`key: ${key}, uploadId: ${s3UploadId}, parts: ${JSON.stringify(parts)}`);
        return res.status(400).json({ error: 'Invalid completion parameters' });
    }

    try {
        const command = new CompleteMultipartUploadCommand({
            Bucket: process.env.DUMBDROP_S3_BUCKET,
            Key: key,
            UploadId: s3UploadId,
            MultipartUpload: {
                Parts: parts
            }
        });

        log.info(`Sending CompleteMultipartUpload command with params: ${JSON.stringify(command.input, null, 2)}`);
        
        const result = await s3Client.send(command);
        log.success(`Completed multipart upload for ${key}`);
        log.info(`Completion response: ${JSON.stringify(result, null, 2)}`);
        
        res.json({ success: true });
    } catch (err) {
        log.error(`Failed to complete multipart upload: ${err.name} - ${err.message}`);
        log.error(`Error stack: ${err.stack}`);
        if (err.$metadata) {
            log.error(`Error metadata: ${JSON.stringify(err.$metadata, null, 2)}`);
        }
        res.status(500).json({ 
            error: 'Failed to complete multipart upload',
            details: {
                message: err.message,
                code: err.code || err.name,
                requestId: err.$metadata?.requestId
            }
        });
    }
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
