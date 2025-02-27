
## Demo Mode

### Overview
DumbDrop includes a demo mode that allows testing the application without actually storing files. Perfect for trying out the interface or development testing.

### Enabling Demo Mode
Set in your environment or docker-compose.yml:
```env
DEMO_MODE=true
```

### Demo Features
- 🚫 No actual file storage - files are processed in memory
- 🎯 Full UI experience with upload/download simulation
- 🔄 Maintains all functionality including:
  - Drag and drop
  - Progress tracking
  - Multiple file uploads
  - Directory structure
  - File listings
- 🚨 Clear visual indicator (red banner) showing demo status
- 🧹 Auto-cleans upload directory on startup
- Files are processed but not written to disk
- Upload progress is simulated
- File metadata stored in memory
- Maintains same API responses as production
- Cleared on server restart