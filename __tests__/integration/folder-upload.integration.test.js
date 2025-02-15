const request = require('supertest');
const path = require('path');
const fs = require('fs').promises;
const { app } = require('../../src/app');

// Import test config
const TEST_CONFIG = {
  port: 3001,
  uploadDir: path.join(__dirname, '../../test_uploads'),
  uploadDisplayPath: path.join(__dirname, '../../test_uploads'),
  maxFileSize: 1024 * 1024, // 1MB
  siteTitle: 'DumbDrop-Test',
  pin: null, // No PIN for tests
  autoUpload: false,
  appriseUrl: null,
  cleanupInterval: 3600000, // 1 hour
  maxAge: 86400000, // 24 hours
};

describe('Folder Upload Integration', () => {
    const testFolderStructure = {
        'test-folder': {
            'file1.txt': 'Content 1',
            'subfolder1': {
                'file2.txt': 'Content 2',
                'file3.txt': 'Content 3'
            },
            'subfolder2': {
                'deep': {
                    'file4.txt': 'Content 4'
                }
            }
        }
    };

    async function createTestFiles(structure, basePath = '') {
        for (const [name, content] of Object.entries(structure)) {
            const fullPath = path.join(basePath, name);
            if (typeof content === 'string') {
                await fs.writeFile(fullPath, content);
            } else {
                await fs.mkdir(fullPath, { recursive: true });
                await createTestFiles(content, fullPath);
            }
        }
    }

    async function uploadFile(filePath, relativePath) {
        const content = await fs.readFile(filePath);
        const size = content.length;

        // Initialize upload
        const initResponse = await request(app)
            .post('/api/upload/init')
            .send({
                filename: relativePath,
                fileSize: size
            });

        expect(initResponse.status).toBe(200);
        const { uploadId } = initResponse.body;

        // Upload content
        const uploadResponse = await request(app)
            .post(`/api/upload/chunk/${uploadId}`)
            .set('Content-Type', 'application/octet-stream')
            .send(content);

        expect(uploadResponse.status).toBe(200);
        return uploadResponse;
    }

    beforeEach(async () => {
        // Create test folder structure
        const testRoot = path.join(TEST_CONFIG.uploadDir, 'test-source');
        await fs.mkdir(testRoot, { recursive: true });
        await createTestFiles(testFolderStructure, testRoot);
    });

    afterEach(async () => {
        // Clean up test folders
        try {
            await fs.rm(path.join(TEST_CONFIG.uploadDir, 'test-source'), { recursive: true, force: true });
        } catch (err) {
            if (err.code !== 'ENOENT') throw err;
        }
    });

    test('should handle complete folder upload with structure', async () => {
        const sourceRoot = path.join(TEST_CONFIG.uploadDir, 'test-source/test-folder');
        
        // Get all files recursively
        async function* getFiles(dir) {
            const entries = await fs.readdir(dir, { withFileTypes: true });
            for (const entry of entries) {
                const fullPath = path.join(dir, entry.name);
                if (entry.isDirectory()) {
                    yield* getFiles(fullPath);
                } else {
                    const relativePath = path.relative(sourceRoot, fullPath);
                    yield { path: fullPath, relativePath };
                }
            }
        }

        // Upload all files
        for await (const file of getFiles(sourceRoot)) {
            const uploadResponse = await uploadFile(
                file.path,
                path.join('test-folder', file.relativePath).replace(/\\/g, '/')
            );
            if (!uploadResponse || !uploadResponse.body) {
                throw new Error('Upload response or body is missing');
            }
            expect(uploadResponse.body.progress).toBe(100);
        }

        // Verify uploaded files
        async function verifyFile(fullPath, expectedContent) {
            const uploadedContent = await fs.readFile(fullPath, 'utf8');
            expect(uploadedContent).toBe(expectedContent);
        }

        async function verifyDirectory(fullPath, content) {
            const stats = await fs.stat(fullPath);
            expect(stats.isDirectory()).toBe(true);
            await verifyFolder(fullPath, content);
        }

        async function verifyFolder(dir, expectedStructure) {
            for (const [name, content] of Object.entries(expectedStructure)) {
                const fullPath = path.join(dir, name);
                if (typeof content === 'string') {
                    await verifyFile(fullPath, content);
                } else {
                    await verifyDirectory(fullPath, content);
                }
            }
        }

        // Wait for all files to be written
        await new Promise(resolve => setTimeout(resolve, 1000));

        // Verify the entire folder structure
        await verifyFolder(
            path.join(TEST_CONFIG.uploadDir, 'test-folder'),
            testFolderStructure['test-folder']
        );
    });

    test('should handle empty folders', async () => {
        const emptyFolderStructure = {
            'empty-test': {
                'empty1': {},
                'empty2': {
                    'empty3': {}
                },
                'file.txt': 'Some content'
            }
        };

        // Create empty folder structure
        const testRoot = path.join(TEST_CONFIG.uploadDir, 'empty-source');
        await fs.mkdir(testRoot, { recursive: true });
        await createTestFiles(emptyFolderStructure, testRoot);

        // Upload the single file
        const filePath = path.join(testRoot, 'empty-test', 'file.txt');
        const uploadResponse = await uploadFile(
            filePath,
            'empty-test/file.txt'
        );

        expect(uploadResponse.body.progress).toBe(100);

        // Verify file was uploaded
        const uploadedContent = await fs.readFile(
            path.join(TEST_CONFIG.uploadDir, 'empty-test', 'file.txt'),
            'utf8'
        );
        expect(uploadedContent).toBe('Some content');
    });

    test('should handle special characters in folder and file names', async () => {
        const specialNameStructure = {
            'test folder with spaces': {
                'file with spaces.txt': 'Content 1',
                'special-chars-!@#$%': {
                    'file-with-symbols-!@#.txt': 'Content 2'
                }
            }
        };

        // Create test structure
        const testRoot = path.join(TEST_CONFIG.uploadDir, 'special-source');
        await fs.mkdir(testRoot, { recursive: true });
        await createTestFiles(specialNameStructure, testRoot);

        // Upload files
        const sourceRoot = path.join(testRoot, 'test folder with spaces');
        const files = [
            {
                path: path.join(sourceRoot, 'file with spaces.txt'),
                relativePath: 'test folder with spaces/file with spaces.txt'
            },
            {
                path: path.join(sourceRoot, 'special-chars-!@#$%', 'file-with-symbols-!@#.txt'),
                relativePath: 'test folder with spaces/special-chars-!@#$%/file-with-symbols-!@#.txt'
            }
        ];

        for (const file of files) {
            const uploadResponse = await uploadFile(file.path, file.relativePath);
            expect(uploadResponse.body.progress).toBe(100);
        }

        // Verify uploaded files
        for (const file of files) {
            const uploadedContent = await fs.readFile(
                path.join(TEST_CONFIG.uploadDir, file.relativePath),
                'utf8'
            );
            const originalContent = await fs.readFile(file.path, 'utf8');
            expect(uploadedContent).toBe(originalContent);
        }
    });
}); 