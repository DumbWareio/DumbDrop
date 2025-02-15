#!/bin/bash

# Set script to exit on error
set -e

# Enable Docker BuildKit
export DOCKER_BUILDKIT=1

# Colors for pretty output
GREEN='\033[0;32m'
BLUE='\033[0;34m'
RED='\033[0;31m'
NC='\033[0m' # No Color

# Helper function for pretty printing
print_message() {
    echo -e "${BLUE}🔧 ${1}${NC}"
}

# Ensure we're in the right directory
cd "$(dirname "$0")"

case "$1" in
    "up")
        print_message "Starting DumbDrop in development mode..."
        if [ ! -f .env.dev ]; then
            print_message "No .env.dev found. Creating from example..."
            cp .env.dev.example .env.dev
        fi
        docker compose -f docker-compose.dev.yml up -d --build
        print_message "Container logs:"
        docker compose -f docker-compose.dev.yml logs
        ;;
    "down")
        print_message "Stopping DumbDrop development environment..."
        docker compose -f docker-compose.dev.yml down
        ;;
    "logs")
        print_message "Showing DumbDrop logs..."
        docker compose -f docker-compose.dev.yml logs -f
        ;;
    "rebuild")
        print_message "Rebuilding DumbDrop..."
        docker compose -f docker-compose.dev.yml build --no-cache
        docker compose -f docker-compose.dev.yml up
        ;;
    "clean")
        print_message "Cleaning up development environment..."
        docker compose -f docker-compose.dev.yml down -v --remove-orphans
        rm -f .env.dev
        print_message "Cleaned up containers, volumes, and env file"
        ;;
    "shell")
        print_message "Opening shell in container..."
        docker compose -f docker-compose.dev.yml exec app sh
        ;;
    "test")
        print_message "Running tests..."
        docker compose -f docker-compose.dev.yml exec app npm test --detectOpenHandles
        ;;
    "lint")
        print_message "Running linter..."
        docker compose -f docker-compose.dev.yml exec app npm run lint
        ;;
    *)
        echo -e "${GREEN}DumbDrop Development Helper${NC}"
        echo "Usage: ./dev.sh [command]"
        echo ""
        echo "Commands:"
        echo "  up        - Start development environment (creates .env.dev if missing)"
        echo "  down      - Stop development environment"
        echo "  logs      - Show container logs"
        echo "  rebuild   - Rebuild container without cache and start"
        echo "  clean     - Clean up everything (containers, volumes, env)"
        echo "  shell     - Open shell in container"
        echo "  test      - Run tests"
        echo "  lint      - Run linter"
        ;;
esac 