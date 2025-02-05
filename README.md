# Dumb Drop

A stupid simple file upload application that provides a clean, modern interface for dragging and dropping files. Built with Node.js and vanilla JavaScript.

![image](https://github.com/user-attachments/assets/2e39d8ef-b250-4689-9553-a580f11c06a7)


No auth (unless you want it now!), no storage, no nothing. Just a simple file uploader to drop dumb files into a dumb folder.

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
- Custom notification messages with filename templating

## Environment Variables

| Variable          | Description                           | Default | Required |
|------------------|---------------------------------------|---------|----------|
| PORT             | Server port                           | 3000    | No       |
| MAX_FILE_SIZE    | Maximum file size in MB               | 1024    | No       |
| DUMBDROP_PIN     | PIN protection (4-10 digits)          | None    | No       |
| DUMBDROP_TITLE   | Site title displayed in header        | DumbDrop| No       |
| APPRISE_URL      | Apprise URL for notifications         | None    | No       |
| APPRISE_MESSAGE  | Notification message template         | New file uploaded {filename} ({size}), Storage used {storage} | No |
| APPRISE_SIZE_UNIT| Size unit for notifications           | Auto    | No       |
| AUTO_UPLOAD      | Enable automatic upload on file selection | false   | No       |
| ALLOWED_EXTENSIONS| Comma-separated list of allowed file extensions | None    | No       |

## File Extension Filtering
To restrict which file types can be uploaded, set the `ALLOWED_EXTENSIONS` environment variable. For example:
```env
ALLOWED_EXTENSIONS=.jpg,.jpeg,.png,.pdf,.doc,.docx,.txt
```
If not set, all file extensions will be allowed.

## Notification Templates
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

## Security Features

- Variable-length PIN support (4-10 digits)
- Constant-time PIN comparison to prevent timing attacks
- Automatic input sanitization
- Secure PIN validation middleware
- No PIN storage in browser (memory only)
- Rate Limiting to prevent brute force attacks
- Optional file extension filtering

## Notification Support
- Integration with [Apprise](https://github.com/caronc/apprise?tab=readme-ov-file#supported-notifications) for flexible notifications
- Support for all Apprise notification services
- Customizable notification messages with filename templating
- Optional - disabled if no APPRISE_URL is set

# Future Features
- Camera Upload for Mobile
- Enhanced Progress Features (upload speed display, time remaining estimation)


## Quick Start

### Running Locally

1. Install dependencies:
```bash
npm install
```

2. Set environment variables in `.env`:
```env
PORT=3000                  # Port to run the server on
MAX_FILE_SIZE=1024        # Maximum file size in MB (default: 1024 MB / 1 GB)
DUMBDROP_PIN=123456       # Optional PIN protection (4-10 digits, leave empty to disable)
```

3. Start the server:
```bash
npm start
```

### Running with Docker

#### Pull from Docker Hub
```bash
# Pull the image
docker pull dumbwareio/dumbdrop:latest

# Run the container
# For Linux/Mac:
docker run -p 3000:3000 -v $(pwd)/local_uploads:/app/uploads -e DUMBDROP_PIN=123456 dumbwareio/dumbdrop:latest

# For Windows PowerShell:
docker run -p 3000:3000 -v "${PWD}\local_uploads:/app/uploads" -e DUMBDROP_PIN=123456 dumbwareio/dumbdrop:latest
```

# Docker Compose
```yml
name: Dumb Drop
services:
    dumbdrop:
        ports:
            - 3000:3000
        volumes:
            - $(pwd)/local_uploads:/app/uploads
        environment:
            - DUMBDROP_PIN=123456
            # - APPRISE_URL=          # i.e. tgram://bottoken/ChatID
            # - APPRISE_MESSAGE= 
        image: dumbwareio/dumbdrop:latest
```

#### Build Locally
1. Build the Docker image:
```bash
docker build -t dumbdrop .
```

2. Run the container:
```bash
# For Linux/Mac:
docker run -p 3000:3000 -v $(pwd)/local_uploads:/app/uploads -e DUMBDROP_PIN=123456 dumbdrop

# For Windows PowerShell:
docker run -p 3000:3000 -v "${PWD}\local_uploads:/app/uploads" -e DUMBDROP_PIN=123456 dumbdrop
```

## Usage

1. Open your browser and navigate to `http://localhost:3000` (unless another domain has been setup)
2. If PIN protection is enabled, enter the 4-10 digit PIN
3. Drag and drop files into the upload area or click "Browse Files"
4. Select one or multiple files
5. Click "Upload Files"
6. Files will be saved to:
   - Local development: `./uploads` directory
   - Docker/Unraid: The directory you mapped to `/app/uploads` in the container

## Technical Details

- Backend: Node.js with Express
- Frontend: Vanilla JavaScript with modern drag-and-drop API
- File handling: Chunked file uploads with configurable size limits
- Security: Optional PIN protection for uploads
- Containerization: Docker with automated builds via GitHub Actions

## Development

Want to contribute or develop locally? Check out our [Development Guide](dev/README.md) - it's stupid simple, just the way we like it! If you're writing complex code to solve a simple problem, you're probably doing it wrong. Keep it dumb, keep it simple.
