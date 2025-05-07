# Base stage for shared configurations
FROM node:20-alpine as base

# Add user and group IDs as arguments with defaults
ARG PUID=1000
ARG PGID=1000
# Default umask (complement of 022 is 755 for dirs, 644 for files)
ARG UMASK=022

# Install necessary packages:
# - su-exec: lightweight sudo alternative
# - python3, pip: for apprise dependency
RUN apk add --no-cache su-exec python3 py3-pip && \
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
RUN ( \
    set -e; \
    echo "Attempting to create/verify user with PUID=${PUID} and PGID=${PGID}..."; \
    \
    # Initialize variables \
    TARGET_USER="nodeuser"; \
    TARGET_GROUP="nodeuser"; \
    NEW_GID="${PGID}"; \
    NEW_UID="${PUID}"; \
    \
    # Step 1: Handle GID and group first \
    echo "Setting up group for GID ${NEW_GID}..."; \
    if getent group "${NEW_GID}" > /dev/null; then \
        # GID exists, check which group has it \
        EXISTING_GROUP=$(getent group "${NEW_GID}" | cut -d: -f1); \
        echo "GID ${NEW_GID} is already used by group '${EXISTING_GROUP}'."; \
        \
        if [ "${EXISTING_GROUP}" = "${TARGET_GROUP}" ]; then \
            echo "Group '${TARGET_GROUP}' already exists with correct GID ${NEW_GID}."; \
        else \
            # GID exists but used by a different group (likely 'node') \
            echo "Will create '${TARGET_GROUP}' with a different GID to avoid conflict."; \
            # Check if TARGET_GROUP exists but with wrong GID \
            if getent group "${TARGET_GROUP}" > /dev/null; then \
                echo "Group '${TARGET_GROUP}' exists but with wrong GID. Deleting it."; \
                delgroup "${TARGET_GROUP}" || true; \
            fi; \
            # Create TARGET_GROUP with GID+1 (or find next available GID) \
            NEXT_GID=$((${NEW_GID} + 1)); \
            while getent group "${NEXT_GID}" > /dev/null; do \
                NEXT_GID=$((${NEXT_GID} + 1)); \
            done; \
            echo "Creating group '${TARGET_GROUP}' with new GID ${NEXT_GID}."; \
            addgroup -S -g "${NEXT_GID}" "${TARGET_GROUP}"; \
            NEW_GID="${NEXT_GID}"; \
        fi; \
    else \
        # GID does not exist - create group with desired GID \
        echo "Creating group '${TARGET_GROUP}' with GID ${NEW_GID}."; \
        addgroup -S -g "${NEW_GID}" "${TARGET_GROUP}"; \
    fi; \
    \
    # Verify group was created \
    echo "Verifying group '${TARGET_GROUP}' exists..."; \
    getent group "${TARGET_GROUP}" || (echo "ERROR: Failed to find group '${TARGET_GROUP}'!"; exit 1); \
    GID_FOR_USER=$(getent group "${TARGET_GROUP}" | cut -d: -f3); \
    echo "Final group: '${TARGET_GROUP}' with GID ${GID_FOR_USER}"; \
    \
    # Step 2: Handle UID and user \
    echo "Setting up user with UID ${NEW_UID}..."; \
    if getent passwd "${NEW_UID}" > /dev/null; then \
        # UID exists, check which user has it \
        EXISTING_USER=$(getent passwd "${NEW_UID}" | cut -d: -f1); \
        echo "UID ${NEW_UID} is already used by user '${EXISTING_USER}'."; \
        \
        if [ "${EXISTING_USER}" = "${TARGET_USER}" ]; then \
            echo "User '${TARGET_USER}' already exists with correct UID ${NEW_UID}."; \
            # Check if user needs group update \
            CURRENT_GID=$(getent passwd "${TARGET_USER}" | cut -d: -f4); \
            if [ "${CURRENT_GID}" != "${GID_FOR_USER}" ]; then \
                echo "User '${TARGET_USER}' has wrong GID (${CURRENT_GID}). Modifying..."; \
                deluser "${TARGET_USER}"; \
                adduser -S -D -u "${NEW_UID}" -G "${TARGET_GROUP}" -s /bin/sh "${TARGET_USER}"; \
            fi; \
        else \
            # Another user has our UID (e.g., 'node'). Delete it. \
            echo "Deleting existing user '${EXISTING_USER}' with UID ${NEW_UID}."; \
            deluser "${EXISTING_USER}" || true; \
            \
            # Now check if TARGET_USER exists but with wrong UID \
            if getent passwd "${TARGET_USER}" > /dev/null; then \
                echo "User '${TARGET_USER}' exists but with wrong UID. Updating..."; \
                deluser "${TARGET_USER}" || true; \
            fi; \
            \
            # Create user \
            echo "Creating user '${TARGET_USER}' with UID ${NEW_UID} and group '${TARGET_GROUP}'."; \
            adduser -S -D -u "${NEW_UID}" -G "${TARGET_GROUP}" -s /bin/sh "${TARGET_USER}"; \
        fi; \
    else \
        # UID does not exist - check if user exists with wrong UID \
        if getent passwd "${TARGET_USER}" > /dev/null; then \
            echo "User '${TARGET_USER}' exists but with wrong UID. Updating..."; \
            deluser "${TARGET_USER}" || true; \
        fi; \
        \
        # Create user with desired UID \
        echo "Creating user '${TARGET_USER}' with UID ${NEW_UID} and group '${TARGET_GROUP}'."; \
        adduser -S -D -u "${NEW_UID}" -G "${TARGET_GROUP}" -s /bin/sh "${TARGET_USER}"; \
    fi; \
    \
    # Create and set permissions on home directory \
    echo "Setting up home directory for ${TARGET_USER}..."; \
    mkdir -p /home/${TARGET_USER} && \
    chown -R ${TARGET_USER}:${TARGET_GROUP} /home/${TARGET_USER} && \
    chmod 755 /home/${TARGET_USER}; \
    \
    # Verify user was created \
    echo "Verifying user '${TARGET_USER}' exists..."; \
    getent passwd "${TARGET_USER}" || (echo "ERROR: Failed to find user '${TARGET_USER}'!"; exit 1); \
    \
    # Clean up and verify system files \
    echo "Ensuring root user definition is pristine..."; \
    chown root:root /etc/passwd /etc/group && \
    chmod 644 /etc/passwd /etc/group && \
    getent passwd root || (echo "ERROR: root not found after user/group operations!"; exit 1); \
    \
    # Print final status \
    echo "Final user/group setup:"; \
    id "${TARGET_USER}"; \
)
WORKDIR /usr/src/app

# Set UMASK - this applies to processes run by the user created in this stage
# The entrypoint will also set it based on the ENV var at runtime.
RUN umask ${UMASK}

# Dependencies stage
FROM base as deps

# Change ownership early so npm cache is owned correctly
RUN chown nodeuser:nodeuser /usr/src/app

# Switch to nodeuser before running npm commands
USER nodeuser

COPY --chown=nodeuser:nodeuser package*.json ./
RUN npm ci --only=production && \
    # Remove npm cache
    npm cache clean --force

# Switch back to root for the next stages if needed
USER root

# Development stage
FROM deps as development

USER root
ENV NODE_ENV=development

# Create and set up directories
RUN mkdir -p /usr/src/app/local_uploads /usr/src/app/uploads && \
    chown -R nodeuser:nodeuser /usr/src/app/local_uploads /usr/src/app/uploads

COPY --chown=nodeuser:nodeuser package*.json ./
RUN npm install && \
    npm cache clean --force

COPY --chown=nodeuser:nodeuser src/ ./src/
COPY --chown=nodeuser:nodeuser public/ ./public/
# Check if __tests__ and dev exist in your project root, if not, these COPY lines will fail for dev target
# COPY --chown=nodeuser:nodeuser __tests__/ ./__tests__/
# COPY --chown=nodeuser:nodeuser dev/ ./dev/
COPY --chown=nodeuser:nodeuser .eslintrc.json .eslintignore .prettierrc nodemon.json ./

# Switch back to nodeuser for runtime
USER nodeuser
EXPOSE 3000

# Production stage
FROM deps as production

USER root
ENV NODE_ENV=production
ENV UPLOAD_DIR /app/uploads

# Create and set up directories
RUN mkdir -p /usr/src/app/local_uploads /usr/src/app/uploads && \
    chown -R nodeuser:nodeuser /usr/src/app/local_uploads /usr/src/app/uploads

# Copy only necessary source files and ensure ownership
COPY --chown=nodeuser:nodeuser src/ ./src/
COPY --chown=nodeuser:nodeuser public/ ./public/

# Copy the entrypoint script and make it executable
COPY --chown=root:root src/scripts/entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh

# Expose port
EXPOSE 3000

# Set the entrypoint
ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]

# Final user should be nodeuser for runtime
USER nodeuser

# Default command to run (passed to entrypoint)
CMD ["npm", "start"]