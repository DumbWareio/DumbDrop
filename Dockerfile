# Base stage for shared configurations
FROM node:20-alpine as base

# Install python and create virtual environment
RUN apk add --no-cache python3 py3-pip && \
    python3 -m venv /opt/venv

# Activate virtual environment and install apprise
RUN . /opt/venv/bin/activate && \
    pip install --no-cache-dir apprise

# Add virtual environment to PATH
ENV PATH="/opt/venv/bin:$PATH"

WORKDIR /usr/src/app

# Development stage
FROM base as development
ENV NODE_ENV=development

COPY package*.json ./
RUN npm install

# Create upload directories
RUN mkdir -p uploads local_uploads

# Copy source
COPY . .

# Expose port
EXPOSE 3000

CMD ["npm", "run", "dev"]

# Production stage
FROM base as production
ENV NODE_ENV=production

COPY package*.json ./
RUN npm ci --only=production

# Create upload directory
RUN mkdir -p uploads

# Copy source
COPY . .

# Expose port
EXPOSE 3000

CMD ["npm", "start"]
