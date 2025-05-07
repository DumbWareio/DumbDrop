/**
 * Server entry point that starts the HTTP server and manages connections.
 * Handles graceful shutdown, connection tracking, and server initialization.
 */

const { app, initialize, config } = require('./app'); // config is now also exported from app.js
const logger = require('./utils/logger');
const fs = require('fs'); // Keep for readdirSync if needed for local dev logging
const { executeCleanup } = require('./utils/cleanup');
const { generatePWAManifest } = require('./scripts/pwa-manifest-generator');

const connections = new Set();

async function startServer() {
  try {
    await initialize(); // This will call validateConfig and load storage adapter via app.js

    const server = app.listen(config.port, () => {
      logger.info(`Server running at ${config.baseUrl}`);
      // ** MODIFIED LOGGING **
      logger.info(`Active Storage Type: ${config.storageType}`);
      logger.info(`Data Directory (for uploads or metadata): ${config.uploadDir}`);

      if (config.nodeEnv === 'development' && config.storageType === 'local') {
        try {
          // Only list contents if it's local storage and dev mode
          if (fs.existsSync(config.uploadDir)) {
            const files = fs.readdirSync(config.uploadDir);
            logger.info(`Current local upload directory contents (${config.uploadDir}):`);
            files.forEach(file => logger.info(`- ${file}`));
          } else {
            logger.warn(`Local upload directory ${config.uploadDir} does not exist for listing.`);
          }
        } catch (err) {
          logger.error(`Failed to list local upload directory contents: ${err.message}`);
        }
      }
    });

    generatePWAManifest();

    server.on('connection', (connection) => {
      connections.add(connection);
      connection.on('close', () => connections.delete(connection));
    });

    let isShuttingDown = false;
    const shutdownHandler = async (signal) => {
      if (isShuttingDown) return;
      isShuttingDown = true;
      logger.info(`${signal} received. Shutting down gracefully...`);
      const forceShutdownTimer = setTimeout(() => {
        logger.error('Force shutdown due to timeout.');
        process.exit(1);
      }, 5000); // Increased slightly

      try {
        server.closeIdleConnections?.(); // Node 18+
        
        const closePromises = Array.from(connections).map(conn => new Promise(resolve => {
            conn.on('close', resolve); // Ensure close event resolves
            conn.destroy(); // Actively destroy connections
        }));
        
        await Promise.race([
            Promise.all(closePromises),
            new Promise(resolve => setTimeout(resolve, 2000)) // Max 2s for connections
        ]);
        connections.clear();


        await new Promise((resolve, reject) => {
            server.close((err) => {
                if (err) return reject(err);
                logger.info('Server closed.');
                resolve();
            });
        });
        
        await executeCleanup(1500); // Max 1.5s for cleanup
        
        clearTimeout(forceShutdownTimer);
        logger.info('Shutdown complete.');
        process.exit(0);
      } catch (error) {
        clearTimeout(forceShutdownTimer); // Clear timer on error too
        logger.error(`Error during shutdown: ${error.message}`);
        process.exit(1);
      }
    };

    process.on('SIGTERM', () => shutdownHandler('SIGTERM'));
    process.on('SIGINT', () => shutdownHandler('SIGINT'));

    return server;
  } catch (error) {
    logger.error('Failed to start server:', error);
    // Ensure process exits if startServer itself fails before listener setup
    process.exitCode = 1; 
    throw error;
  }
}

if (require.main === module) {
  startServer().catch((error) => {
    // Error already logged by startServer
    // process.exitCode is already set if startServer throws
  });
}

module.exports = { app, startServer };