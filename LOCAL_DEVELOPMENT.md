# Local Development (Recommended Quick Start)

## Prerequisites

- **Node.js** >= 20.0.0  
  _Why?_: The app uses features only available in Node 20+.
- **npm** (comes with Node.js)
- **Python 3** (for notification testing, optional)
- **Apprise** (for notification testing, optional)

## Setup Instructions

1. **Clone the repository**
   ```bash
   git clone https://github.com/yourusername/dumbdrop.git
   cd dumbdrop
   ```

2. **Copy and configure environment variables**
   ```bash
   cp .env.example .env
   ```
   - Open `.env` in your editor and review the variables.
   - At minimum, set:
     - `PORT=3000`
     - `LOCAL_UPLOAD_DIR=./local_uploads`
     - `MAX_FILE_SIZE=1024`
     - `DUMBDROP_PIN=` (optional, for PIN protection)
     - `APPRISE_URL=` (optional, for notifications)

3. **Install dependencies**
   ```bash
   npm install
   ```

4. **Start the development server**
   ```bash
   npm run dev
   ```
   - You should see output like:
     ```
     DumbDrop server running on http://localhost:3000
     ```

5. **Open the app**
   - Go to [http://localhost:3000](http://localhost:3000) in your browser.

---

## Testing File Uploads

- Drag and drop files onto the web interface.
- Supported file types: _All_, unless restricted by `ALLOWED_EXTENSIONS` in `.env`.
- Maximum file size: as set by `MAX_FILE_SIZE` (default: 1024 MB).
- Uploaded files are stored in the directory specified by `LOCAL_UPLOAD_DIR` (default: `./local_uploads`).
- To verify uploads:
  - Check the `local_uploads` folder for your files.
  - The UI will show a success message on upload.

---

## Notification Testing (Python/Apprise)

If you want to test notifications (e.g., for new uploads):

1. **Install Python 3**  
   - [Download Python](https://www.python.org/downloads/) if not already installed.

2. **Install Apprise**
   ```bash
   pip install apprise
   ```

3. **Configure Apprise in `.env`**
   - Set `APPRISE_URL` to your notification service URL (see [Apprise documentation](https://github.com/caronc/apprise)).
   - Example for a local test:
     ```
     APPRISE_URL=mailto://your@email.com
     ```

4. **Trigger a test notification**
   - Upload a file via the web UI.
   - If configured, you should receive a notification.

---

## Troubleshooting

**Problem:** Port already in use  
**Solution:**  
- Change the `PORT` in `.env` to a free port.

**Problem:** "Cannot find module 'express'"  
**Solution:**  
- Run `npm install` to install dependencies.

**Problem:** File uploads not working  
**Solution:**  
- Ensure `LOCAL_UPLOAD_DIR` exists and is writable.
- Check file size and extension restrictions in `.env`.

**Problem:** Notifications not sent  
**Solution:**  
- Verify `APPRISE_URL` is set and correct.
- Ensure Apprise is installed and accessible.

**Problem:** Permission denied on uploads  
**Solution:**  
- Make sure your user has write permissions to `local_uploads`.

**Problem:** Environment variables not loading  
**Solution:**  
- Double-check that `.env` exists and is formatted correctly.
- Restart the server after making changes.

---

## Additional Notes

- For Docker-based development, see the "Quick Start" and "Docker Compose" sections in the main README.
- For more advanced configuration, review the "Configuration" section in the main README.
- If you encounter issues not listed here, please open an issue on GitHub or check the Discussions tab. 