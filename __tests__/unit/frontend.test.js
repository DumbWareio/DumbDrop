const fs = require('fs').promises;
const path = require('path');

// Mock browser APIs
global.File = class MockFile {
    constructor(parts, filename, options = {}) {
        this.name = filename;
        this.size = parts[0]?.length || 0;
        this.type = options.type || '';
        this.lastModified = options.lastModified || Date.now();
        this.webkitRelativePath = options.webkitRelativePath || '';
    }
};

// Mock FileReader API
global.FileReader = class MockFileReader {
    readAsArrayBuffer() {
        this.onload && this.onload({ target: { result: new ArrayBuffer(8) } });
    }
};

// Load the frontend code
const fs_actual = require('fs');
const html = fs_actual.readFileSync(path.join(__dirname, '../../public/index.html'), 'utf8');
const scriptContent = html.match(/<script defer>([\s\S]*?)<\/script>/)[1];

// Create a clean environment for each test
function createTestEnvironment() {
    const env = {
        console: {
            log: jest.fn(),
            error: jest.fn(),
            debug: jest.fn(),
            warn: jest.fn()
        },
        document: {
            getElementById: jest.fn(),
            createElement: jest.fn(() => ({
                className: '',
                style: {},
                appendChild: jest.fn()
            })),
            head: {
                appendChild: jest.fn()
            }
        },
        fetch: jest.fn(),
        FileUploader: null,
        getAllFileEntries: null,
        updateFileList: null
    };

    // Execute script in mock environment
    const script = new Function('window', `
        const document = window.document;
        const console = window.console;
        const fetch = window.fetch;
        ${scriptContent}
        window.FileUploader = FileUploader;
        window.getAllFileEntries = getAllFileEntries;
        window.updateFileList = updateFileList;
    `);
    
    script(env);
    return env;
}

describe('Frontend Upload Functionality', () => {
    let env;

    beforeEach(() => {
        env = createTestEnvironment();
        jest.clearAllMocks();
    });

    describe('Folder Structure Handling', () => {
        test('should properly handle folder structure from webkitdirectory input', async () => {
            const mockFiles = [
                new File(['content'], 'file1.txt', { webkitRelativePath: 'folder/file1.txt' }),
                new File(['content'], 'file2.txt', { webkitRelativePath: 'folder/subfolder/file2.txt' }),
                new File(['content'], 'file3.txt', { webkitRelativePath: 'folder/file3.txt' })
            ];

            // Mock DOM elements
            const fileList = { innerHTML: '' };
            env.document.getElementById.mockReturnValue(fileList);

            // Call updateFileList
            env.updateFileList.call({ files: mockFiles });

            // Verify folder structure was created correctly
            expect(env.document.createElement).toHaveBeenCalledWith('div');
            expect(env.console.debug).toHaveBeenCalledWith(
                expect.stringContaining('Folder structure detection'),
                expect.objectContaining({ hasRootFolder: true })
            );
        });

        test('should maintain folder structure during drag and drop', async () => {
            const mockEntry = {
                isFile: false,
                isDirectory: true,
                name: 'testfolder',
                createReader: () => ({
                    readEntries: (callback) => callback([
                        {
                            isFile: true,
                            isDirectory: false,
                            name: 'file1.txt',
                            file: (cb) => cb(new File(['content'], 'file1.txt'))
                        },
                        {
                            isFile: false,
                            isDirectory: true,
                            name: 'subfolder',
                            createReader: () => ({
                                readEntries: (callback) => callback([
                                    {
                                        isFile: true,
                                        isDirectory: false,
                                        name: 'file2.txt',
                                        file: (cb) => cb(new File(['content'], 'file2.txt'))
                                    }
                                ])
                            })
                        }
                    ])
                })
            };

            const result = await env.getAllFileEntries([{ webkitGetAsEntry: () => mockEntry }]);

            expect(result).toHaveLength(2);
            expect(result[0].webkitRelativePath).toContain('testfolder/file1.txt');
            expect(result[1].webkitRelativePath).toContain('testfolder/subfolder/file2.txt');
        });

        test('should handle empty folders', async () => {
            const mockEntry = {
                isFile: false,
                isDirectory: true,
                name: 'emptyfolder',
                createReader: () => ({
                    readEntries: (callback) => callback([])
                })
            };

            const result = await env.getAllFileEntries([{ webkitGetAsEntry: () => mockEntry }]);

            expect(result).toHaveLength(0);
            expect(env.console.debug).toHaveBeenCalledWith(
                expect.stringContaining('Processing directory contents'),
                expect.objectContaining({ totalEntries: 0 })
            );
        });

        test('should handle files with special characters in names', async () => {
            const mockFiles = [
                new File(['content'], 'file with spaces.txt', { 
                    webkitRelativePath: 'folder with spaces/file with spaces.txt' 
                }),
                new File(['content'], 'file-with-dashes.txt', { 
                    webkitRelativePath: 'folder with spaces/file-with-dashes.txt' 
                })
            ];

            const fileList = { innerHTML: '' };
            env.document.getElementById.mockReturnValue(fileList);

            env.updateFileList.call({ files: mockFiles });

            expect(env.console.debug).toHaveBeenCalledWith(
                expect.stringContaining('Processing file in updateFileList'),
                expect.objectContaining({
                    path: expect.stringContaining('folder with spaces/')
                })
            );
        });

        test('should properly calculate folder sizes', async () => {
            const mockFiles = [
                new File(['small'], 'small.txt', { 
                    webkitRelativePath: 'folder/small.txt' 
                }),
                new File(['medium'.repeat(100)], 'medium.txt', { 
                    webkitRelativePath: 'folder/subfolder/medium.txt' 
                }),
                new File(['large'.repeat(1000)], 'large.txt', { 
                    webkitRelativePath: 'folder/large.txt' 
                })
            ];

            const fileList = { innerHTML: '' };
            env.document.getElementById.mockReturnValue(fileList);

            env.updateFileList.call({ files: mockFiles });

            // Verify folder size calculations in debug logs
            expect(env.console.debug).toHaveBeenCalledWith(
                expect.stringContaining('Final structure'),
                expect.objectContaining({
                    folders: expect.arrayContaining([
                        expect.objectContaining({
                            size: expect.any(Number)
                        })
                    ])
                })
            );
        });
    });

    describe('Upload Initialization', () => {
        test('should properly initialize uploads with folder structure', async () => {
            const mockFile = new File(['content'], 'test.txt', { 
                webkitRelativePath: 'folder/test.txt' 
            });
            
            env.fetch.mockResolvedValueOnce({
                ok: true,
                json: () => Promise.resolve({ uploadId: 'test-id' })
            });

            const uploader = new env.FileUploader(mockFile, 'batch-id');
            await uploader.initUpload();

            expect(env.fetch).toHaveBeenCalledWith(
                '/api/upload/init',
                expect.objectContaining({
                    body: expect.stringContaining('folder/test.txt')
                })
            );
        });
    });
}); 