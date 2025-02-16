# DumbDrop

A stupid simple file upload application that provides a clean, modern interface for dragging and dropping files. Built with Node.js and vanilla JavaScript.

![DumbDrop](https://github.com/user-attachments/assets/1b909d26-9ead-4dc7-85bc-8bfda0d366c1)

No auth (unless you want it now!), no storage, no nothing. Just a simple file uploader to drop dumb files into a dumb folder.

## Table of Contents
- [Quick Start](#quick-start)
- [Features](#features)
- [Configuration](#configuration)
- [Security](#security)
- [Development](#development)
- [Technical Details](#technical-details)
- [Contributing](#contributing)
- [License](#license)

## Quick Start

### Prerequisites
- Docker (recommended)
- Node.js >=20.0.0 (for local development)

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
```

Then run:
```bash
docker compose up -d
```

1. Go to http://localhost:3000
2. Upload a File - It'll show up in ./local_uploads
3. Rejoice in the glory of your dumb uploads

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

- 🚀 Drag and drop file uploads
- 📁 Multiple file selection
- 🎨 Clean, responsive UI with Dark Mode
- 📦 Docker support with easy configuration
- 📂 Directory upload support (maintains structure)
- 🔒 Optional PIN protection
- 📱 Mobile-friendly interface
- 🔔 Configurable notifications via Apprise
- ⚡ Zero dependencies on client-side
- 🛡️ Built-in security features
- 💾 Configurable file size limits
- 🎯 File extension filtering

## Configuration

### Environment Variables

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

## Security

### Features
- Variable-length PIN support (4-10 digits)
- Constant-time PIN comparison
- Input sanitization
- Rate limiting
- File extension filtering
- No client-side PIN storage
- Secure file handling

## Technical Details

### Stack
- **Backend**: Node.js (>=20.0.0) with Express
- **Frontend**: Vanilla JavaScript (ES6+)
- **Container**: Docker with multi-stage builds
- **Security**: Express security middleware
- **Upload**: Chunked file handling via Multer
- **Notifications**: Apprise integration

### Dependencies
- express: Web framework
- multer: File upload handling
- apprise: Notification system
- cors: Cross-origin resource sharing
- dotenv: Environment configuration
- express-rate-limit: Rate limiting

## Contributing

1. Fork the repository
2. Create your feature branch (`git checkout -b feature/amazing-feature`)
3. Commit your changes using conventional commits
4. Push to the branch (`git push origin feature/amazing-feature`)
5. Open a Pull Request

See [Development Guide](dev/README.md) for local setup and guidelines.




---
Made with ❤️ by [DumbWare.io](https://dumbware.io)

## Future Features
- Camera Upload for Mobile
> Got an idea? [Open an issue](https://github.com/dumbwareio/dumbdrop/issues) or [submit a PR](https://github.com/dumbwareio/dumbdrop/pulls)
