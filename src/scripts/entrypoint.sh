#!/bin/sh
# Simple entrypoint script to manage user permissions and execute CMD

# Exit immediately if a command exits with a non-zero status.
set -e

# Function to log messages
log_info() {
    echo "[INFO] Entrypoint: $1"
}

log_warning() {
    echo "[WARN] Entrypoint: $1"
}

log_error() {
    echo "[ERROR] Entrypoint: $1" >&2
}

log_info "Starting entrypoint script..."

# Default user/group/umask values
DEFAULT_UID=1000
DEFAULT_GID=1000
DEFAULT_UMASK=022
# Default upload directory if not set by user (should align with Dockerfile/compose)
DEFAULT_UPLOAD_DIR="/usr/src/app/local_uploads"

# Check if PUID or PGID environment variables are set by the user
if [ -z "${PUID}" ] && [ -z "${PGID}" ]; then
    # --- Run as Root --- 
    log_info "PUID/PGID not set, running as root."
    
    # Set umask (use UMASK env var if provided, otherwise default)
    CURRENT_UMASK=${UMASK:-$DEFAULT_UMASK}
    log_info "Setting umask to ${CURRENT_UMASK}"
    umask "${CURRENT_UMASK}"
    
    # Execute the command passed to the entrypoint as root
    log_info "Executing command as root: $@"
    exec "$@"

else
    # --- Run as Custom User (nodeuser with adjusted UID/GID) ---
    log_info "PUID/PGID set, configuring user 'nodeuser'..."
    
    # Use provided UID/GID or default if only one is set
    CURRENT_UID=${PUID:-$DEFAULT_UID} 
    CURRENT_GID=${PGID:-$DEFAULT_GID}
    CURRENT_UMASK=${UMASK:-$DEFAULT_UMASK}
    # Read the upload directory from ENV var or use default
    TARGET_UPLOAD_DIR=${UPLOAD_DIR:-$DEFAULT_UPLOAD_DIR}
    
    log_info "Target UID: ${CURRENT_UID}, GID: ${CURRENT_GID}, UMASK: ${CURRENT_UMASK}"
    log_info "Target Upload Dir: ${TARGET_UPLOAD_DIR}"

    # Check if user/group exists (should exist from Dockerfile)
    if ! getent group nodeuser > /dev/null 2>&1; then
        log_warning "Group 'nodeuser' not found, creating with GID ${CURRENT_GID}..."
        addgroup -g "${CURRENT_GID}" nodeuser
    else
        EXISTING_GID=$(getent group nodeuser | cut -d: -f3)
        if [ "${EXISTING_GID}" != "${CURRENT_GID}" ]; then
            log_info "Updating 'nodeuser' group GID from ${EXISTING_GID} to ${CURRENT_GID}..."
            groupmod -o -g "${CURRENT_GID}" nodeuser
        fi
    fi

    if ! getent passwd nodeuser > /dev/null 2>&1; then
        log_warning "User 'nodeuser' not found, creating with UID ${CURRENT_UID}..."
        adduser -u "${CURRENT_UID}" -G nodeuser -s /bin/sh -D nodeuser
    else
        EXISTING_UID=$(getent passwd nodeuser | cut -d: -f3)
        if [ "${EXISTING_UID}" != "${CURRENT_UID}" ]; then
            log_info "Updating 'nodeuser' user UID from ${EXISTING_UID} to ${CURRENT_UID}..."
            usermod -o -u "${CURRENT_UID}" nodeuser
        fi
    fi
    
    # Ensure the base application directory ownership is correct
    log_info "Ensuring ownership of /usr/src/app..."
    chown -R nodeuser:nodeuser /usr/src/app || log_warning "Could not chown /usr/src/app"
    
    # Ensure the target upload directory exists and has correct ownership
    if [ -n "${TARGET_UPLOAD_DIR}" ]; then
        if [ ! -d "${TARGET_UPLOAD_DIR}" ]; then
            log_info "Creating directory: ${TARGET_UPLOAD_DIR}"
            # Use -p to create parent directories as needed
            mkdir -p "${TARGET_UPLOAD_DIR}"
            # Chown after creation
            chown nodeuser:nodeuser "${TARGET_UPLOAD_DIR}" || log_warning "Could not chown ${TARGET_UPLOAD_DIR}"
        else
            # Directory exists, ensure ownership
            log_info "Ensuring ownership of ${TARGET_UPLOAD_DIR}..."
            chown -R nodeuser:nodeuser "${TARGET_UPLOAD_DIR}" || log_warning "Could not chown ${TARGET_UPLOAD_DIR}"
        fi
    else
         log_warning "UPLOAD_DIR variable is not set or is empty, skipping ownership check for upload directory."
    fi
    
    # Set the umask
    log_info "Setting umask to ${CURRENT_UMASK}"
    umask "${CURRENT_UMASK}"
    
    # Execute the command passed to the entrypoint using su-exec to drop privileges
    log_info "Executing command as nodeuser (${CURRENT_UID}:${CURRENT_GID}): $@"
    exec su-exec nodeuser "$@"
fi

log_info "Entrypoint script finished (should not reach here if exec worked)." 