const ALLOWED_ORIGINS = process.env.ALLOWED_ORIGINS || process.env.ALLOWED_IFRAME_ORIGINS || '*';
const NODE_ENV = process.env.NODE_ENV || 'production';
let allowedOrigins = [];

function setupOrigins(baseUrl) {
    const normalizedBaseUrl = normalizeOrigin(baseUrl);
    allowedOrigins = [ normalizedBaseUrl ];

    if (NODE_ENV === 'development' || ALLOWED_ORIGINS === '*') allowedOrigins = '*';
    else if (ALLOWED_ORIGINS && typeof ALLOWED_ORIGINS === 'string') {
        try {
          const allowed = ALLOWED_ORIGINS.split(',').map(origin => origin.trim());
          allowed.forEach(origin => {
              const normalizedOrigin = normalizeOrigin(origin);
              if (normalizedOrigin !== baseUrl) allowedOrigins.push(normalizedOrigin);
          });
        }
        catch (error) {
            console.error(`Error setting up ALLOWED_ORIGINS: ${ALLOWED_ORIGINS}:`, error);
        }
    }
    console.log("ALLOWED ORIGINS:", allowedOrigins);
    return allowedOrigins;
}

function normalizeOrigin(origin) {
  if (origin) {
      try {
          const normalizedOrigin = new URL(origin).origin;
          return normalizedOrigin;
      } catch (error) {
          console.error("Error parsing referer URL:", error);
          throw new Error("Error parsing referer URL:", error);
      }
  }
}

function validateOrigin(origin) {
  if (NODE_ENV === 'development' || allowedOrigins === '*') return true;

  try {
      if (origin) origin = normalizeOrigin(origin);
      else {
          console.warn("No origin to validate.");
          return false;
      }

      console.log("Validating Origin:", origin);
      if (allowedOrigins.includes(origin)) {
        console.log("Allowed request from origin:", origin);
        return true;
      } 
      else {
          console.warn("Blocked request from origin:", origin);
          return false;
      }
  }
  catch (error) {
      console.error(error);
  }
}

function originValidationMiddleware(req, res, next) {
  const origin = req.headers.origin || req.headers.referer || `${req.protocol}://${req.headers.host}`;
  const isOriginValid = validateOrigin(origin);
  if (isOriginValid) {
      next();
  } else {
      res.status(403).json({ error: 'Forbidden' });
  }
}

function getCorsOptions(baseUrl) {
  const allowedOrigins = setupOrigins(baseUrl);
  const corsOptions = {
    origin: allowedOrigins,
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Pin', 'X-Batch-Id'],
  };
  return corsOptions;
}

module.exports = { getCorsOptions, originValidationMiddleware, validateOrigin, allowedOrigins };