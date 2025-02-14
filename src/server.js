const { app, initialize, config } = require('./app');
const logger = require('./utils/logger');
const fs = require('fs');
const { executeCleanup } = require('./utils/cleanup');

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
    
    // Start the server
    const server = app.listen(config.port, () => {
      logger.info(`Server running at http://localhost:${config.port}`);
      logger.info(`Upload directory: ${config.uploadDisplayPath}`);
      
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

    // Track new connections
    server.on('connection', (connection) => {
      connections.add(connection);
      connection.on('close', () => {
        connections.delete(connection);
      });
    });

    // Shutdown handler function
    const shutdownHandler = async (signal) => {
      logger.info(`${signal} received. Shutting down gracefully...`);
      
      // Start a shorter force shutdown timer
      const forceShutdownTimer = setTimeout(() => {
        logger.error('Force shutdown initiated');
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
        process.exit(0); // Exit immediately since we're done
      } catch (error) {
        logger.error(`Error during shutdown: ${error.message}`);
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
    process.exit(1);
  });
}

module.exports = { app, startServer }; 