# DumbDrop

A stupid simple file upload application that provides a clean, modern interface for dragging and dropping files. Built with Node.js and vanilla JavaScript.

![DumbDrop](https://github.com/user-attachments/assets/1b909d26-9ead-4dc7-85bc-8bfda0d366c1)

No auth (unless you want it!), no complicated setup (unless you want to!), no nothing. Just a simple way to drop dumb files into a dumb folder... or an S3 bucket!

## Table of Contents
- [Quick Start](#quick-start)
- [Production Deployment with Docker](#production-deployment-with-docker)
- [Local Development (Recommended Quick Start)](LOCAL_DEVELOPMENT.md)
- [Features](#features)
- [Configuration](#configuration)
- [Security](#security)
- [Technical Details](#technical-details)
- [Demo Mode](demo.md)
- [Contributing](#contributing)
- [License](#license)

## Quick Start

### Option 1: Docker (For Dummies - Local Storage)
```bash
# Pull and run with one command (uses local storage)
docker run -p 3000:3000 -v ./uploads:/app/uploads dumbwareio/dumbdrop:latest
```
1. Go to http://localhost:3000
2. Upload a File - It'll show up in `./uploads` on your host machine.
3. Celebrate on how dumb easy this was.

### Option 2: Docker Compose (For Dummies who like customizing - Local or S3)
Create a `docker-compose.yml` file:

```yaml
services:
  dumbdrop:
    image: dumbwareio/dumbdrop:latest # Use the desired tag/version
    ports:
      - "3000:3000" # Map host port 3000 to container port 3000
    volumes:
      # Mount a host directory to store metadata (.metadata folder)
      # This is needed even for S3 mode to track ongoing uploads.
      # For local storage mode, this is also where files land.
      - ./uploads:/app/uploads
    environment:
      # --- Core Settings ---
      # STORAGE_TYPE: "local" # Options: "local", "s3" (Defaults to "local" if unset)
      DUMBDROP_TITLE: "My DumbDrop"
      BASE_URL: "http://localhost:3000/" # Must end with a slash!
      MAX_FILE_SIZE: 1024 # Max file size in MB
      DUMBDROP_PIN: "" # Optional PIN (4-10 digits)
      AUTO_UPLOAD: "false" # Set to "true" to upload immediately

      # --- Local Storage Settings (if STORAGE_TYPE="local") ---
      UPLOAD_DIR: "/app/uploads" # *Must* be set inside container if using local storage

      # --- S3 Storage Settings (if STORAGE_TYPE="s3") ---
      # S3_REGION: "us-east-1" # Your S3 region (e.g., us-west-000 for B2)
      # S3_BUCKET_NAME: "your-s3-bucket-name" # Your bucket name
      # S3_ACCESS_KEY_ID: "YOUR_ACCESS_KEY" # Your S3 Access Key
      # S3_SECRET_ACCESS_KEY: "YOUR_SECRET_KEY" # Your S3 Secret Key
      # S3_ENDPOINT_URL: "" # Optional: e.g., https://s3.us-west-000.backblazeb2.com for B2, http://minio.local:9000 for Minio
      # S3_FORCE_PATH_STYLE: "false" # Optional: Set to "true" for providers like Minio

      # --- Optional Settings ---
      # ALLOWED_EXTENSIONS: ".jpg,.png,.pdf" # Comma-separated allowed extensions
      # ALLOWED_IFRAME_ORIGINS: "https://organizr.example.com" # Allow embedding in specific origins
      # APPRISE_URL: "" # For notifications
      # FOOTER_LINKS: "My Site @ https://example.com" # Custom footer links
      # CLIENT_MAX_RETRIES: 5 # Client-side chunk retry attempts
    restart: unless-stopped
```
Then run:
```bash
docker compose up -d
```
1. Go to http://localhost:3000
2. Upload a File - It'll show up in `./uploads` (if local) or your S3 bucket (if S3).
3. Rejoice in the glory of your dumb uploads, now potentially in the cloud!

> **Note:** When using `STORAGE_TYPE=s3`, the local volume mount (`./uploads:/app/uploads`) is still used to store temporary metadata files (`.metadata` folder) for tracking multipart uploads. The actual files go to S3.

### Option 3: Running Locally (For Developers)

For local development setup without Docker, see the dedicated guide:

👉 [Local Development Guide](LOCAL_DEVELOPMENT.md)

## Features

- 🚀 Drag and drop file uploads
- 📁 Multiple file selection
- ☁️ **Optional S3 Storage:** Store files in AWS S3, Backblaze B2, MinIO, or other S3-compatible services.
- 💾 **Local Storage:** Default simple file storage on the server's disk.
- 🎨 Clean, responsive UI with Dark Mode
- 📦 Docker support with easy configuration
- 📂 Directory upload support (maintains structure in local storage or as S3 keys)
- 🔒 Optional PIN protection
- 📱 Mobile-friendly interface
- 🔔 Configurable notifications via Apprise
- ⚡ Zero dependencies on client-side
- 🛡️ Built-in security features (rate limiting, security headers)
- 💾 Configurable file size limits
- 🎯 File extension filtering
- ⚙️ Native S3 Multipart Upload for large files when using S3 storage.
- 🔗 S3 Presigned URLs for efficient downloads (offloads server bandwidth).

## Configuration

DumbDrop is configured primarily through environment variables.

### Environment Variables

| Variable                 | Description                                                                                                | Default                                      | Required                     |
|--------------------------|------------------------------------------------------------------------------------------------------------|----------------------------------------------|------------------------------|
| **`STORAGE_TYPE`**       | Storage backend: `local` or `s3`                                                                           | `local`                                      | No                           |
| `PORT`                   | Server port                                                                                                | `3000`                                       | No                           |
| `BASE_URL`               | Base URL for the application (must end with `/`)                                                           | `http://localhost:PORT/`                     | No                           |
| `MAX_FILE_SIZE`          | Maximum file size in MB                                                                                    | `1024`                                       | No                           |
| `DUMBDROP_PIN`           | PIN protection (4-10 digits)                                                                               | None                                         | No                           |
| `DUMBDROP_TITLE`         | Title displayed in the browser tab/header                                                                  | `DumbDrop`                                   | No                           |
| `AUTO_UPLOAD`            | Enable automatic upload on file selection (`true`/`false`)                                                 | `false`                                      | No                           |
| `ALLOWED_EXTENSIONS`     | Comma-separated list of allowed file extensions (e.g., `.jpg,.png`)                                        | None (all allowed)                           | No                           |
| `ALLOWED_IFRAME_ORIGINS` | Comma-separated list of origins allowed to embed in an iframe                                              | None                                         | No                           |
| `FOOTER_LINKS`           | Comma-separated custom footer links (Format: `"Text @ URL"`)                                               | None                                         | No                           |
| `CLIENT_MAX_RETRIES`     | Max retry attempts for client-side chunk uploads                                                           | `5`                                          | No                           |
| `DEMO_MODE`              | Run in demo mode (`true`/`false`). Overrides storage settings.                                             | `false`                                      | No                           |
| `APPRISE_URL`            | Apprise URL for notifications                                                                              | None                                         | No                           |
| `APPRISE_MESSAGE`        | Notification message template (`{filename}`, `{size}`, `{storage}`)                                        | `New file uploaded...`                       | No                           |
| `APPRISE_SIZE_UNIT`      | Size unit for notifications (`B`, `KB`, `MB`, `GB`, `TB`, `Auto`)                                          | `Auto`                                       | No                           |
| ---                      | ---                                                                                                        | ---                                          | ---                          |
| **Local Storage Only:**  |                                                                                                            |                                              |                              |
| `UPLOAD_DIR`             | **(Docker)** Directory for uploads/metadata inside container                                               | None                                         | Yes (if `STORAGE_TYPE=local`) |
| `LOCAL_UPLOAD_DIR`       | **(Local Dev)** Directory for uploads/metadata on host machine                                             | `./local_uploads`                            | No (if `STORAGE_TYPE=local`) |
| ---                      | ---                                                                                                        | ---                                          | ---                          |
| **S3 Storage Only:**     |                                                                                                            |                                              |                              |
| `S3_REGION`              | S3 Region (e.g., `us-east-1`, `us-west-000`)                                                               | None                                         | Yes (if `STORAGE_TYPE=s3`)   |
| `S3_BUCKET_NAME`         | Name of the S3 Bucket                                                                                      | None                                         | Yes (if `STORAGE_TYPE=s3`)   |
| `S3_ACCESS_KEY_ID`       | S3 Access Key ID                                                                                           | None                                         | Yes (if `STORAGE_TYPE=s3`)   |
| `S3_SECRET_ACCESS_KEY`   | S3 Secret Access Key                                                                                       | None                                         | Yes (if `STORAGE_TYPE=s3`)   |
| `S3_ENDPOINT_URL`        | **(Optional)** Custom S3 endpoint URL (for B2, MinIO, etc.)                                                | None (uses default AWS endpoint)             | No                           |
| `S3_FORCE_PATH_STYLE`    | **(Optional)** Force path-style S3 requests (`true`/`false`). Needed for MinIO, etc.                       | `false`                                      | No                           |

-   **Storage:** Set `STORAGE_TYPE` to `s3` to enable S3 storage. Otherwise, it defaults to `local`.
-   **Local Storage:** If `STORAGE_TYPE=local`, `UPLOAD_DIR` (in Docker) or `LOCAL_UPLOAD_DIR` (local dev) determines where files are stored.
-   **S3 Storage:** If `STORAGE_TYPE=s3`, the `S3_*` variables are required. `UPLOAD_DIR`/`LOCAL_UPLOAD_DIR` is still used for storing temporary `.metadata` files locally.
-   **S3 Endpoint/Path Style:** Use `S3_ENDPOINT_URL` and `S3_FORCE_PATH_STYLE` only if connecting to a non-AWS S3-compatible service.
-   **BASE_URL**: Must end with a trailing slash (`/`). The app will fail to start otherwise. Example: `http://your.domain.com/dumbdrop/`.
-   **Security Note (S3):** For production, using IAM Roles (e.g., EC2 Instance Profiles, ECS Task Roles) is strongly recommended over embedding Access Keys in environment variables.

See `.env.example` for a template.

<details>
<summary>ALLOWED_IFRAME_ORIGINS</summary>

To allow this app to be embedded in an iframe on specific origins (such as Organizr), set the `ALLOWED_IFRAME_ORIGINS` environment variable. For example:

```env
ALLOWED_IFRAME_ORIGINS=https://organizr.example.com,https://myportal.com
```

- If not set, the app will only allow itself to be embedded in an iframe on the same origin (default security).
- If set, the app will allow embedding in iframes on the specified origins and itself.
- **Security Note:** Only add trusted origins. Allowing arbitrary origins can expose your app to clickjacking and other attacks.
</details>

<details>
<summary>File Extension Filtering</summary>

To restrict which file types can be uploaded, set the `ALLOWED_EXTENSIONS` environment variable with comma-separated extensions (including the dot):
```env
ALLOWED_EXTENSIONS=.jpg,.jpeg,.png,.pdf,.doc,.docx,.txt
```
If not set, all file extensions will be allowed.
</details>

<details>
<summary>Notification Setup</summary>

#### Message Templates
The notification message supports the following placeholders:
- `{filename}`: Name of the uploaded file (or S3 Key)
- `{size}`: Size of the file (formatted according to APPRISE_SIZE_UNIT)
- `{storage}`: Total size of all files in upload directory (Local storage only)

Example message template:
```env
APPRISE_MESSAGE: New file dropped: {filename} ({size})!
```

Size formatting examples:
- Auto (default): Chooses nearest unit (e.g., "1.44MB", "256KB")
- Fixed unit: Set APPRISE_SIZE_UNIT to B, KB, MB, GB, or TB

#### Notification Support
- Integration with [Apprise](https://github.com/caronc/apprise?tab=readme-ov-file#supported-notifications) for flexible notifications
- Customizable notification messages
- Optional - disabled if no APPRISE_URL is set
</details>

<details>
<summary>S3 Cleanup Recommendation</summary>

When using `STORAGE_TYPE=s3`, DumbDrop relies on the native S3 Multipart Upload mechanism. If an upload is interrupted, incomplete parts may remain in your S3 bucket.

**It is strongly recommended to configure a Lifecycle Rule on your S3 bucket** (or use your provider's equivalent tool) to automatically abort and delete incomplete multipart uploads after a reasonable period (e.g., 1-7 days). This prevents orphaned parts from accumulating costs. DumbDrop's cleanup only removes local tracking files, not the actual S3 parts.
</details>

## Security

### Features
- Variable-length PIN support (4-10 digits)
- Constant-time PIN comparison
- Input sanitization (filenames, paths)
- Rate limiting on API endpoints
- Security headers (CSP, HSTS, etc.)
- File extension filtering
- No client-side PIN storage
- Secure file handling (uses S3 presigned URLs for downloads if S3 is enabled)

## Technical Details

### Stack
- **Backend**: Node.js (>=20.0.0) with Express
- **Frontend**: Vanilla JavaScript (ES6+)
- **Storage**: Local Filesystem or S3-compatible Object Storage
- **Container**: Docker with multi-stage builds
- **Security**: Express security middleware
- **Upload**: Chunked uploads via client-side logic, processed via Express middleware, using native S3 Multipart Upload when `STORAGE_TYPE=s3`.
- **Notifications**: Apprise integration
- **SDK**: AWS SDK for JavaScript v3 (`@aws-sdk/client-s3`, `@aws-sdk/s3-request-presigner`) when `STORAGE_TYPE=s3`.

### Dependencies
- `express`: Web framework
- `@aws-sdk/client-s3`: AWS S3 SDK (used if `STORAGE_TYPE=s3`)
- `@aws-sdk/s3-request-presigner`: For S3 presigned URLs (used if `STORAGE_TYPE=s3`)
- `cookie-parser`: Parse cookies
- `cors`: Cross-origin resource sharing
- `dotenv`: Environment configuration
- `express-rate-limit`: Rate limiting

## Contributing

1. Fork the repository
2. Create your feature branch (`git checkout -b feature/amazing-feature`)
3. Commit your changes using conventional commits
4. Push to the branch (`git push origin feature/amazing-feature`)
5. Open a Pull Request

See [Local Development (Recommended Quick Start)](LOCAL_DEVELOPMENT.md) for local setup and guidelines.

---
Made with ❤️ by [DumbWare.io](https://dumbware.io)

## Future Features
> Got an idea? [Open an issue](https://github.com/dumbwareio/dumbdrop/issues) or [submit a PR](https://github.com/dumbwareio/dumbdrop/pulls)
