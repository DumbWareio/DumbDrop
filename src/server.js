/**
 * Server entry point that starts the HTTP server and manages connections.
 * Handles graceful shutdown, connection tracking, and server initialization.
 * Provides development mode directory listing functionality.
 */

const { app, initialize, config } = require('./app');
const logger = require('./utils/logger');
const fs = require('fs');
const { executeCleanup } = require('./utils/cleanup');
const { generatePWAManifest } = require('./scripts/pwa-manifest-generator')

// Track open connections
const connections = new Set();

/**
 * Start the server and initialize the application
 * @returns {Promise<http.Server>} The HTTP server instance
 */
async function startServer() {
  try {
    // Initialize the application
    await initialize();
    
    // Start the server - bind to 0.0.0.0 for Docker compatibility
    const server = app.listen(config.port, '0.0.0.0', () => {
      logger.info(`Server running at ${config.baseUrl}`);
      logger.info(`Server listening on 0.0.0.0:${config.port}`);
      logger.info(`Upload directory: ${config.uploadDir}`);
      
      // List directory contents in development
      if (config.nodeEnv === 'development') {
        try {
          const files = fs.readdirSync(config.uploadDir);
          logger.info(`Current directory contents (${files.length} files):`);
          files.forEach(file => {
            logger.info(`- ${file}`);
          });
        } catch (err) {
          logger.error(`Failed to list directory contents: ${err.message}`);
        }
      }
    });

    // Dynamically generate PWA manifest into public folder
    generatePWAManifest();

    // Track new connections
    server.on('connection', (connection) => {
      connections.add(connection);
      connection.on('close', () => {
        connections.delete(connection);
      });
    });

    // Shutdown handler function
    let isShuttingDown = false; // Prevent multiple shutdowns
    const shutdownHandler = async (signal) => {
      if (isShuttingDown) return;
      isShuttingDown = true;
      logger.info(`${signal} received. Shutting down gracefully...`);
      
      // Start a shorter force shutdown timer
      const forceShutdownTimer = setTimeout(() => {
        logger.error('Force shutdown initiated');
        // eslint-disable-next-line n/no-process-exit
        process.exit(1);
      }, 3000); // 3 seconds maximum for total shutdown
      
      try {
        // 1. Stop accepting new connections immediately
        server.unref();
        
        // 2. Close all existing connections with a shorter timeout
        const connectionClosePromises = Array.from(connections).map(conn => {
          return new Promise(resolve => {
            conn.end(() => {
              connections.delete(conn);
              resolve();
            });
          });
        });
        
        // Wait for connections to close with a timeout
        await Promise.race([
          Promise.all(connectionClosePromises),
          new Promise(resolve => setTimeout(resolve, 1000)) // 1 second timeout for connections
        ]);
        
        // 3. Close the server
        await new Promise((resolve) => server.close(resolve));
        logger.info('Server closed');
        
        // 4. Run cleanup tasks with a shorter timeout
        await executeCleanup(1000); // 1 second timeout for cleanup
        
        // Clear the force shutdown timer since we completed gracefully
        clearTimeout(forceShutdownTimer);
        process.exitCode = 0;
        // eslint-disable-next-line n/no-process-exit
        process.exit(0); // Ensure immediate exit
      } catch (error) {
        logger.error(`Error during shutdown: ${error.message}`);
        // eslint-disable-next-line n/no-process-exit
        process.exit(1);
      }
    };

    // Handle both SIGTERM and SIGINT
    process.on('SIGTERM', () => shutdownHandler('SIGTERM'));
    process.on('SIGINT', () => shutdownHandler('SIGINT'));

    return server;
  } catch (error) {
    logger.error('Failed to start server:', error);
    throw error;
  }
}

// Only start the server if this file is run directly
if (require.main === module) {
  startServer().catch((error) => {
    logger.error('Server failed to start:', error);
    process.exitCode = 1;
    throw error;
  });
}

module.exports = { app, startServer }; 