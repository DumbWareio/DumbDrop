# Base stage for shared configurations
FROM node:20-alpine as base

# Add user and group IDs as arguments with defaults
ARG PUID=1000
ARG PGID=1000
# Default umask (complement of 022 is 755 for dirs, 644 for files)
ARG UMASK=022

# Install necessary packages:
# - shadow: for user/group management (usermod, groupmod)
# - su-exec: lightweight sudo alternative
# - python3, pip: for apprise dependency
RUN apk add --no-cache shadow su-exec python3 py3-pip && \
    python3 -m venv /opt/venv && \
    rm -rf /var/cache/apk/*

# Activate virtual environment and install apprise
RUN . /opt/venv/bin/activate && \
    pip install --no-cache-dir apprise && \
    find /opt/venv -type d -name "__pycache__" -exec rm -r {} +

# Add virtual environment to PATH
ENV PATH="/opt/venv/bin:$PATH"

# Create group and user with fallback to prevent build failures
# We use the ARG values here, but with a fallback mechanism to avoid build failures
RUN addgroup -g ${PGID} nodeuser 2>/dev/null || \
    (echo "Group with GID ${PGID} already exists, creating with alternate GID" && addgroup nodeuser) && \
    adduser -u ${PUID} -G nodeuser -s /bin/sh -D nodeuser 2>/dev/null || \
    (echo "User with UID ${PUID} already exists, creating with alternate UID" && adduser -G nodeuser -s /bin/sh -D nodeuser)

WORKDIR /usr/src/app

# Set UMASK - this applies to processes run by the user created in this stage
# The entrypoint will also set it based on the ENV var at runtime.
RUN umask ${UMASK}

# Dependencies stage
FROM base as deps

# Change ownership early so npm cache is owned correctly
RUN chown nodeuser:nodeuser /usr/src/app
USER nodeuser

COPY --chown=nodeuser:nodeuser package*.json ./
RUN npm ci --only=production && \
    # Remove npm cache
    npm cache clean --force

# Switch back to root temporarily for steps requiring root privileges if any
# USER root

# Development stage
# Note: Running dev stage as non-root might require adjustments
# depending on tooling (e.g., nodemon needing specific permissions)
# For now, let's keep it simpler and potentially run dev as root or figure out permissions later if needed.
FROM deps as development
USER root # Switch back to root for installing dev deps and copying files owned by host
ENV NODE_ENV=development

# Install dev dependencies
COPY --chown=nodeuser:nodeuser package*.json ./
RUN npm install && \
    npm cache clean --force

# Create and own upload/data directories
# Using local_uploads based on project structure, also create standard uploads
RUN mkdir -p /usr/src/app/local_uploads /usr/src/app/uploads && \
    chown -R nodeuser:nodeuser /usr/src/app/local_uploads /usr/src/app/uploads

# Copy source code - ensure ownership is correct if needed later
COPY --chown=nodeuser:nodeuser src/ ./src/
COPY --chown=nodeuser:nodeuser public/ ./public/
COPY --chown=nodeuser:nodeuser __tests__/ ./__tests__/
COPY --chown=nodeuser:nodeuser dev/ ./dev/
COPY --chown=nodeuser:nodeuser .eslintrc.json .eslintignore .prettierrc nodemon.json ./

# Expose port
EXPOSE 3000

# We won't switch user yet for dev, might cause issues with host mounts/debugging
# USER nodeuser
# CMD ["npm", "run", "dev"] # Default CMD, likely overridden by compose

# Production stage
FROM deps as production
USER root # Switch back to root for creating dirs and copying files
ENV NODE_ENV=production
ENV UPLOAD_DIR /app/uploads

# Create and own upload/data directories
RUN mkdir -p /usr/src/app/local_uploads /usr/src/app/uploads && \
    chown -R nodeuser:nodeuser /usr/src/app /usr/src/app/local_uploads /usr/src/app/uploads

# Copy only necessary source files and ensure ownership
COPY --chown=nodeuser:nodeuser src/ ./src/
COPY --chown=nodeuser:nodeuser public/ ./public/

# Copy the entrypoint script and make it executable
COPY --chown=nodeuser:nodeuser src/scripts/entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh

# Expose port
EXPOSE 3000

# Set the entrypoint
ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]

# Default command to run (passed to entrypoint)
CMD ["npm", "start"]

# USER nodeuser # User switch happens inside entrypoint script using su-exec
