# DumbDrop

A stupid simple file upload application that provides a clean, modern interface for dragging and dropping files. Built with Node.js and vanilla JavaScript.

![DumbDrop](https://github.com/user-attachments/assets/1b909d26-9ead-4dc7-85bc-8bfda0d366c1)

No auth (unless you want it now!), no storage, no nothing. Just a simple file uploader to drop dumb files into a dumb folder.

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

### Option 1: Docker (For Dummies)

```bash
# Pull and run with one command
docker run -p 3000:3000 -v ./uploads:/app/uploads dumbwareio/dumbdrop:latest
```

1. Go to http://localhost:3000
2. Upload a File - It'll show up in ./uploads
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
      - ./uploads:/app/uploads
    environment:
      # Explicitly set upload directory inside the container
      UPLOAD_DIR: /app/uploads
      # The title shown in the web interface
      DUMBDROP_TITLE: DumbDrop
      # Maximum file size in MB
      MAX_FILE_SIZE: 1024
      # Optional PIN protection (leave empty to disable)
      DUMBDROP_PIN: 123456
      # Upload without clicking button
      AUTO_UPLOAD: false
      # The base URL for the application
      # You must update this to the url you use to access your site
      BASE_URL: http://localhost:3000
```

Then run:

```bash
docker compose up -d
```

1. Go to http://localhost:3000
2. Upload a File - It'll show up in ./uploads
3. Rejoice in the glory of your dumb uploads

> **Note:** The `UPLOAD_DIR` environment variable is now explicitly set to `/app/uploads` in the container. The Dockerfile only creates the `uploads` directory, not `local_uploads`. The host directory `./uploads` is mounted to `/app/uploads` for persistent storage.

### Option 3: Running Locally (For Developers)

For local development setup, troubleshooting, and advanced usage, see the dedicated guide:

👉 [Local Development Guide](LOCAL_DEVELOPMENT.md)

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
- 📋 Optional file listing with download/delete functionality

## Configuration

### Environment Variables

| Variable                                                 | Description                                                                                                                           | Default                                                       | Required |
| -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------- | -------- |
| PORT                                                     | Server port                                                                                                                           | 3000                                                          | No       |
| BASE_URL                                                 | Base URL for the application                                                                                                          | http://localhost:PORT                                         | No       |
| MAX_FILE_SIZE                                            | Maximum file size in MB                                                                                                               | 1024                                                          | No       |
| DUMBDROP_PIN                                             | PIN protection (4-10 digits)                                                                                                          | None                                                          | No       |
| DUMBDROP_TITLE                                           | Site title displayed in header                                                                                                        | DumbDrop                                                      | No       |
| APPRISE_URL                                              | Apprise URL for notifications                                                                                                         | None                                                          | No       |
| APPRISE_MESSAGE                                          | Notification message template                                                                                                         | New file uploaded {filename} ({size}), Storage used {storage} | No       |
| APPRISE_SIZE_UNIT                                        | Size unit for notifications (B, KB, MB, GB, TB, or Auto)                                                                              | Auto                                                          | No       |
| AUTO_UPLOAD                                              | Enable automatic upload on file selection                                                                                             | false                                                         | No       |
| SHOW_FILE_LIST                                           | Enable file listing with download and delete functionality                                                                            | false                                                         | No       |
| ALLOWED_EXTENSIONS                                       | Comma-separated list of allowed file extensions                                                                                       | None                                                          | No       |
| ALLOWED_IFRAME_ORIGINS (deprecated: see ALLOWED_ORIGINS) | Comma-separated list of origins allowed to embed the app in an iframe                                                                 | None                                                          | No       |
| ALLOWED_ORIGINS                                          | You can restrict CORS to your BASE_URL or a comma-separated list of specified origins, which will automatically include your base_url | '\*'                                                          | No       |
| UPLOAD_DIR                                               | Directory for uploads (Docker/production; should be `/app/uploads` in container)                                                      | None (see LOCAL_UPLOAD_DIR fallback)                          | No       |
| LOCAL_UPLOAD_DIR                                         | Directory for uploads (local dev, fallback: './local_uploads')                                                                        | ./local_uploads                                               | No       |
| TRUST_PROXY                                              | Trust proxy headers (X-Forwarded-For) - only enable if behind a reverse proxy                                                         | false                                                         | No       |
| TRUSTED_PROXY_IPS                                        | Comma-separated list of trusted proxy IPs (optional, requires TRUST_PROXY=true)                                                       | None                                                          | No       |

- **UPLOAD_DIR** is used in Docker/production. If not set, LOCAL_UPLOAD_DIR is used for local development. If neither is set, the default is `./local_uploads`.
- **Docker Note:** The Dockerfile now only creates the `uploads` directory inside the container. The host's `./local_uploads` is mounted to `/app/uploads` and should be managed on the host system.
- **BASE_URL**: If you are deploying DumbDrop under a subpath (e.g., `https://example.com/watchfolder/`), you **must** set `BASE_URL` to the full path including the trailing slash (e.g., `https://example.com/watchfolder/`). All API and asset requests will be prefixed with this value. If you deploy at the root, use `https://example.com/`.
- **BASE_URL** must end with a trailing slash. The app will fail to start if this is not the case.

See `.env.example` for a template and more details.

<details>
<summary>Reverse Proxy Configuration (TRUST_PROXY)</summary>

### Important Security Notice

By default, DumbDrop **does not** trust proxy headers like `X-Forwarded-For`. This prevents attackers from spoofing IP addresses to bypass rate limiting and PIN brute-force protection.

### When to Enable TRUST_PROXY

Only enable `TRUST_PROXY=true` if you are deploying DumbDrop behind a **trusted reverse proxy** such as:
- Nginx
- Apache
- Caddy
- Traefik
- Cloudflare
- Other CDN or load balancer

### Basic Configuration

If behind a single reverse proxy:

```env
TRUST_PROXY=true
```

### Advanced Configuration (Recommended)

For additional security, specify the exact IP addresses of your trusted proxies:

```env
TRUST_PROXY=true
TRUSTED_PROXY_IPS=172.17.0.1,10.0.0.1
```

**Common proxy IPs:**
- Docker default bridge: `172.17.0.1`
- Docker Compose networks: Check with `docker network inspect <network_name>`
- Nginx/Apache on same host: `127.0.0.1` or `::1`
- External proxy: Use the actual IP of your proxy server

### Security Warnings

⚠️ **DO NOT enable `TRUST_PROXY` if:**
- DumbDrop is directly accessible from the internet
- You are unsure whether you have a reverse proxy
- You cannot verify the proxy IP addresses

⚠️ **Enabling proxy trust without a properly configured reverse proxy allows attackers to bypass security measures by spoofing headers.**

### Examples for Common Setups

**Nginx Reverse Proxy:**
```env
TRUST_PROXY=true
TRUSTED_PROXY_IPS=172.17.0.1
```

**Cloudflare:**
```env
TRUST_PROXY=true
# List Cloudflare IPs or use their published IP ranges
```

**Direct Access (No Proxy):**
```env
# TRUST_PROXY=false (default - no need to set)
```

</details>

<details>
<summary>ALLOWED_IFRAME_ORIGINS (DEPRECATED: see ALLOWED_ORIGINS)</summary>

- This is now deprecated but still works for backwards compatibility
- ALLOWED_IFRAME_ORIGINS will be used as a fallback if ALLOWED_ORIGINS is not set
- Please update to ALLOWED_ORIGINS for future compatibility

~~To allow this app to be embedded in an iframe on specific origins (such as Organizr), set the `ALLOWED_IFRAME_ORIGINS` environment variable. For example:~~

```env
ALLOWED_IFRAME_ORIGINS=https://organizr.example.com,https://myportal.com
```

- ~~If not set, the app will only allow itself to be embedded in an iframe on the same origin (default security).~~
- ~~If set, the app will allow embedding in iframes on the specified origins and itself.~~
- ~~**Security Note:** Only add trusted origins. Allowing arbitrary origins can expose your app to clickjacking and other attacks.~~
</details>

<details>
<summary>ALLOWED_ORIGINS</summary>

By default `ALLOWED_ORIGINS` is set to '\*'

```env
ALLOWED_ORIGINS=https://organizr.example.com,https://myportal.com,http://internalip:port
```

- If you would like to restrict CORS to your BASE_URL, you can set it like this: `ALLOWED_ORIGINS=http://localhost:3000`
- If you would like to allow multiple origins, you can set it like this: `ALLOWED_ORIGINS=http://internalip:port,https://subdomain.domain.tld`
  - This will automatically include your BASE_URL in the list of allowed origins.
  </details>

<details>
<summary>File Extension Filtering</summary>

To restrict which file types can be uploaded, set the `ALLOWED_EXTENSIONS` environment variable. For example:

```env
ALLOWED_EXTENSIONS=.jpg,.jpeg,.png,.pdf,.doc,.docx,.txt
```

If not set, all file extensions will be allowed.

</details>

<details>
<summary>File Listing and Management</summary>

To enable the file listing feature that shows uploaded files with download and delete functionality, set the `SHOW_FILE_LIST` environment variable:

```env
SHOW_FILE_LIST=true
```

When enabled, this feature provides:

- **File Listing**: Displays all uploaded files and folders in a hierarchical structure
- **Download**: Direct download links for individual files
- **Delete**: Ability to delete files and entire folders (including all contents)
- **Statistics**: Shows total number of files and total storage used
- **Refresh**: Manual refresh button to update the file list
- **Folder Support**: Properly displays folder structures with nested files

**Security Note:** The file listing respects the same security measures as the upload functionality. If a PIN is configured, users must authenticate before accessing file management features.

The file list automatically refreshes after successful uploads to keep the display current.

</details>

<details>
<summary>Notification Setup</summary>

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
</details>

## Security

### Features

- Variable-length PIN support (4-10 digits)
- Constant-time PIN comparison
- Input sanitization
- Rate limiting with IP-based tracking
- Protection against IP spoofing attacks
- Configurable proxy trust for reverse proxy deployments
- File extension filtering
- No client-side PIN storage
- Secure file handling

### Security Best Practices

1. **PIN Protection**: Always set a strong PIN when deploying publicly
2. **Proxy Trust**: Only enable `TRUST_PROXY` when behind a verified reverse proxy
3. **HTTPS**: Use HTTPS in production (handled by your reverse proxy)
4. **File Extensions**: Restrict allowed file types using `ALLOWED_EXTENSIONS` if possible
5. **Regular Updates**: Keep DumbDrop and its dependencies up to date

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

See [Local Development (Recommended Quick Start)](LOCAL_DEVELOPMENT.md) for local setup and guidelines.

## Support the Project

<a href="https://www.buymeacoffee.com/dumbware" target="_blank">
  <img src="https://cdn.buymeacoffee.com/buttons/v2/default-yellow.png" alt="Buy Me A Coffee" height="60">
</a>

---

Made with ❤️ by [DumbWare.io](https://dumbware.io)

## Future Features

- Camera Upload for Mobile
  > Got an idea? [Open an issue](https://github.com/dumbwareio/dumbdrop/issues) or [submit a PR](https://github.com/dumbwareio/dumbdrop/pulls)
