# DumbDrop Development Guide

## Quick Start

1. Clone the repository:
   ```bash
   git clone https://github.com/yourusername/DumbDrop.git
   cd DumbDrop
   ```

2. Set up development environment:
   ```bash
   cd dev
   cp .env.dev.example .env.dev
   ```

3. Start development server:
   ```bash
   docker-compose -f docker-compose.dev.yml up
   ```

The application will be available at http://localhost:3000 with hot-reloading enabled.

## Development Environment Features

- Hot-reloading with nodemon
- Development-specific environment variables
- Local file storage in `../local_uploads`
- Debug logging enabled
- Development-specific notifications

## Project Structure

```
DumbDrop/
├── dev/                    # Development configurations
│   ├── docker-compose.dev.yml
│   ├── .env.dev.example
│   └── README.md
├── src/                    # Application source code
├── public/                # Static assets
├── local_uploads/         # Development file storage
└── [Production files in root]
```

## Development Workflow

1. Create feature branches from `main`:
   ```bash
   git checkout -b feature/your-feature-name
   ```

2. Make changes and test locally
3. Commit using conventional commits:
   ```bash
   feat: add new feature
   fix: resolve bug
   docs: update documentation
   ```

4. Push and create pull request

## Debugging

- Use `DEBUG=dumbdrop:*` for detailed logs
- Container shell access: `docker-compose -f docker-compose.dev.yml exec app sh`
- Logs: `docker-compose -f docker-compose.dev.yml logs -f app`

## Common Issues

1. Port conflicts: Change port in `.env.dev`
2. File permissions: Ensure proper ownership of `local_uploads`
3. Node modules: Remove and rebuild with `docker-compose -f docker-compose.dev.yml build --no-cache`
