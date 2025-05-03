# Base stage for shared configurations
FROM node:20-alpine as base

# Install python and create virtual environment with minimal dependencies
RUN apk add --no-cache python3 py3-pip && \
    python3 -m venv /opt/venv && \
    rm -rf /var/cache/apk/*

# Activate virtual environment and install apprise
RUN . /opt/venv/bin/activate && \
    pip install --no-cache-dir apprise && \
    find /opt/venv -type d -name "__pycache__" -exec rm -r {} +

# Add virtual environment to PATH
ENV PATH="/opt/venv/bin:$PATH"

WORKDIR /usr/src/app

# Dependencies stage
FROM base as deps

COPY package*.json ./
RUN npm ci --only=production && \
    # Remove npm cache
    npm cache clean --force

# Development stage
FROM deps as development
ENV NODE_ENV=development

# Install dev dependencies
RUN npm install && \
    npm cache clean --force

# Create upload directory
RUN mkdir -p uploads

# Copy source with specific paths to avoid unnecessary files
COPY src/ ./src/
COPY public/ ./public/
COPY __tests__/ ./__tests__/
COPY dev/ ./dev/
COPY .eslintrc.json .eslintignore ./

# Expose port
EXPOSE 3000

CMD ["npm", "run", "dev"]

# Production stage
FROM deps as production
ENV NODE_ENV=production

# Create upload directory
RUN mkdir -p uploads

# Copy only necessary source files
COPY src/ ./src/
COPY public/ ./public/

# Expose port
EXPOSE 3000

CMD ["npm", "start"]
