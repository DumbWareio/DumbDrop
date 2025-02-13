const { app, initialize, config } = require('./app');
const logger = require('./utils/logger');
const fs = require('fs');

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

    // Handle shutdown gracefully
    process.on('SIGTERM', () => {
      logger.info('SIGTERM received. Shutting down gracefully...');
      server.close(() => {
        logger.info('Server closed');
        process.exit(0);
      });
    });

    return server;
  } catch (error) {
    logger.error('Failed to start server:', error);
    process.exit(1);
  }
}

// Only start the server if this file is run directly
if (require.main === module) {
  startServer();
}

module.exports = { app, startServer }; 