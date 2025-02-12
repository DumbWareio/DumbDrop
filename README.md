# DumbDrop

A stupid simple file upload application that provides a clean, modern interface for dragging and dropping files. Built with Node.js and vanilla JavaScript.

![image](https://github.com/user-attachments/assets/346a4cf8-5e89-4b1f-bb1f-4ea8603230eb)

No auth (unless you want it now!), no storage, no nothing. Just a simple file uploader to drop dumb files into a dumb folder.

## Quick Start

### Option 1: Docker (For Dummies)
```bash
# Pull and run with one command
docker run -p 3000:3000 -v ./local_uploads:/app/uploads dumbwareio/dumbdrop:latest
```
1. Go to http://localhost:3000
2. Upload a File - It'll show up in ./local_uploads
3. Celebrate on how dumb easy this was

### Option 2: Docker Compose (For Dummies who like customizing)
Create a `docker-compose.yml` file:
```yaml
services:
    dumbdrop:
        image: dumbwareio/dumbdrop:latest
        ports:
            - 3000:3000
        volumes:
            # Where your uploaded files will land
            - ./local_uploads:/app/uploads 
        environment:
            # The title shown in the web interface
            DUMBDROP_TITLE: DumbDrop
            # Maximum file size in MB
            MAX_FILE_SIZE: 1024
            # Optional PIN protection (leave empty to disable)
            DUMBDROP_PIN: 123456
            # Upload without clicking button
            AUTO_UPLOAD: false
            # Storage Configuration (local or s3)
            DUMBDROP_STORAGE: local
```

Then run:
```bash
docker compose up -d
```

1. Go to http://localhost:3000
2. Upload a File - It'll show up in ./local_uploads
3. Rejoice in the glory of your dumb uploads

### Storage Configuration

DumbDrop supports two storage backends:

#### Local Storage (Default)
Files are stored directly on the local filesystem. This is the simplest setup and requires no additional configuration.
```yaml
services:
    dumbdrop:
        environment:
            DUMBDROP_STORAGE: local  # This is the default, can be omitted
```

#### S3-Compatible Storage
Support for any S3-compatible storage service (AWS S3, MinIO, etc). Enable by setting the following environment variables:
```yaml
services:
    dumbdrop:
        environment:
            DUMBDROP_STORAGE: s3
            DUMBDROP_S3_KEY: <your-access-key>
            DUMBDROP_S3_SECRET: <your-secret-key>
            DUMBDROP_S3_BUCKET: <your-bucket-name>
            DUMBDROP_S3_ENDPOINT: <your-endpoint>
            DUMBDROP_S3_REGION: <your-region>
```

S3 storage features:
- Multipart upload support for large files
- Folder structure preservation
- Presigned URL support for direct-to-S3 uploads

### Option 3: Running Locally (For Developers)

> If you're a developer, check out our [Dev Guide](#development) for the dumb setup.

1. Install dependencies:
```bash
npm install
```

2. Set environment variables in `.env`:
```env
PORT=3000                  # Port to run the server on
MAX_FILE_SIZE=1024        # Maximum file size in MB
DUMBDROP_PIN=123456       # Optional PIN protection
```

3. Start the server:
```bash
npm start
```

#### Windows Users
If you're using Windows PowerShell with Docker, use this format for paths:
```bash
docker run -p 3000:3000 -v "${PWD}\local_uploads:/app/uploads" dumbwareio/dumbdrop:latest
```

## Features

- Drag and drop file uploads
- Multiple file selection
- Clean, responsive UI
- File size display
- Docker support
- Dark Mode toggle
- Configurable file size limits
- Drag and Drop Directory Support (Maintains file structure in upload)
- Optional PIN protection (4-10 digits) with secure validation
- Configurable notifications via Apprise

## Configuration

### Environment Variables

| Variable          | Description                           | Default | Required |
|------------------|---------------------------------------|---------|----------|
| PORT             | Server port                           | 3000    | No       |
| MAX_FILE_SIZE    | Maximum file size in MB               | 1024    | No       |
| DUMBDROP_PIN     | PIN protection (4-10 digits)          | None    | No       |
| DUMBDROP_TITLE   | Site title displayed in header        | DumbDrop| No       |
| DUMBDROP_STORAGE | Storage backend (local or s3)         | local   | No       |
| DUMBDROP_S3_KEY  | S3 access key                        | None    | Yes (if s3) |
| DUMBDROP_S3_SECRET | S3 secret key                      | None    | Yes (if s3) |
| DUMBDROP_S3_BUCKET | S3 bucket name                     | None    | Yes (if s3) |
| DUMBDROP_S3_ENDPOINT | S3 endpoint URL                  | None    | Yes (if s3) |
| DUMBDROP_S3_REGION | S3 region                         | None    | Yes (if s3) |
| APPRISE_URL      | Apprise URL for notifications         | None    | No       |
| APPRISE_MESSAGE  | Notification message template         | New file uploaded {filename} ({size}), Storage used {storage} | No |
| APPRISE_SIZE_UNIT| Size unit for notifications           | Auto    | No       |
| AUTO_UPLOAD      | Enable automatic upload on file selection | false   | No       |
| ALLOWED_EXTENSIONS| Comma-separated list of allowed file extensions | None    | No       |

### File Extension Filtering
To restrict which file types can be uploaded, set the `ALLOWED_EXTENSIONS` environment variable. For example:
```env
ALLOWED_EXTENSIONS=.jpg,.jpeg,.png,.pdf,.doc,.docx,.txt
```
If not set, all file extensions will be allowed.

### Notification Setup

#### Message Templates
The notification message supports the following placeholders:
- `{filename}`: Name of the uploaded file
- `{size}`: Size of the file (formatted according to APPRISE_SIZE_UNIT)
- `{storage}`: Total size of all files in upload directory

Example message template:
```env
APPRISE_MESSAGE: New file uploaded {filename} ({size}), Storage used {storage}
```

Size formatting examples:
- Auto (default): Chooses nearest unit (e.g., "1.44MB", "256KB")
- Fixed unit: Set APPRISE_SIZE_UNIT to B, KB, MB, GB, or TB

Both {size} and {storage} use the same formatting rules based on APPRISE_SIZE_UNIT.

#### Notification Support
- Integration with [Apprise](https://github.com/caronc/apprise?tab=readme-ov-file#supported-notifications) for flexible notifications
- Support for all Apprise notification services
- Customizable notification messages with filename templating
- Optional - disabled if no APPRISE_URL is set

## Security Features

- Variable-length PIN support (4-10 digits)
- Constant-time PIN comparison to prevent timing attacks
- Automatic input sanitization
- Secure PIN validation middleware
- No PIN storage in browser (memory only)
- Rate Limiting to prevent brute force attacks
- Optional file extension filtering

## Development

Want to contribute or develop locally? Check out our [Development Guide](dev/README.md) - it's stupid simple, just the way we like it! If you're writing complex code to solve a simple problem, you're probably doing it wrong. Keep it dumb, keep it simple.

## Technical Details

- Backend: Node.js with Express
- Frontend: Vanilla JavaScript with modern drag-and-drop API
- File handling: Chunked file uploads with configurable size limits
- Security: Optional PIN protection for uploads
- Containerization: Docker with automated builds via GitHub Actions

## Future Features
- Camera Upload for Mobile
> Got an idea? [Open an issue](https://github.com/dumbwareio/dumbdrop/issues) or [submit a PR](https://github.com/dumbwareio/dumbdrop/pulls)
