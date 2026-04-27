const ALLOWED_ORIGINS = process.env.ALLOWED_ORIGINS || process.env.ALLOWED_IFRAME_ORIGINS || '*';
const NODE_ENV = process.env.NODE_ENV || 'production';
const CORS_ALLOW_PROTOCOL_MISMATCH = process.env.CORS_ALLOW_PROTOCOL_MISMATCH !== 'false'; // Default: allow protocol mismatches behind TLS-terminating proxies
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
              if (normalizedOrigin !== normalizedBaseUrl) allowedOrigins.push(normalizedOrigin);
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
          console.error("Error parsing origin URL:", error);
          throw new Error(`Error parsing origin URL: ${origin}`);
      }
  }
}

function hasMatchingHost(origin, allowlist) {
  if (!Array.isArray(allowlist)) {
    return false;
  }

  try {
    // Compare hostnames (not ports) to support proxies that strip default ports
    const incomingHostname = new URL(origin).hostname;
    return allowlist.some((allowedOrigin) => {
      try {
        return new URL(allowedOrigin).hostname === incomingHostname;
      } catch {
        return false;
      }
    });
  } catch {
    return false;
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
      // Protocol mismatch handling: behind TLS-terminating reverse proxies (e.g., load balancers, ingress controllers),
      // the incoming request may be http but the allowed origin is https. This check allows matching by host only
      // (scheme is not enforced) when CORS_ALLOW_PROTOCOL_MISMATCH is true (default). This reduces CORS security
      // but is necessary for proxied deployments. To enforce strict scheme parity, set CORS_ALLOW_PROTOCOL_MISMATCH=false.
      if (CORS_ALLOW_PROTOCOL_MISMATCH && hasMatchingHost(origin, allowedOrigins)) {
        console.log("Allowed request from matching host (protocol mismatch allowed):", origin);
        return true;
      }
      else {
          console.warn("Blocked request from origin:", origin);
          return false;
      }
  }
  catch (error) {
      console.error(error);
      return false;
  }
}

function originValidationMiddleware(req, res, next) {
  // Browser navigation and some same-origin requests do not include Origin/Referer.
  // Allow those requests and rely on authentication/rate limiting for protection.
  const rawOrigin = req.headers.origin || req.headers.referer;
  if (!rawOrigin) {
    return next();
  }

  const isOriginValid = validateOrigin(rawOrigin);
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