const logger = require('../logger');

/**
 * Global Express error handler
 * Don't leak stack traces in production
 */
function errorHandler(err, req, res, next) {
  const statusCode = err.statusCode || 500;
  const isProduction = process.env.NODE_ENV === 'production';

  // Log the error
  logger.error(`${req.method} ${req.url} - ${err.message}${err.stack ? '\n' + err.stack : ''}`);

  // Determine error code
  let errorCode = 'INTERNAL_ERROR';
  if (statusCode === 400) errorCode = 'BAD_REQUEST';
  else if (statusCode === 401) errorCode = 'UNAUTHORIZED';
  else if (statusCode === 403) errorCode = 'FORBIDDEN';
  else if (statusCode === 404) errorCode = 'NOT_FOUND';
  else if (statusCode === 413) errorCode = 'PAYLOAD_TOO_LARGE';
  else if (statusCode === 429) errorCode = 'RATE_LIMITED';

  const response = {
    error: isProduction ? 'An error occurred' : err.message,
    code: errorCode,
  };

  // Only include stack in development
  if (!isProduction && err.stack) {
    response.stack = err.stack;
  }

  res.status(statusCode).json(response);
}

/**
 * 404 handler for undefined routes
 */
function notFoundHandler(req, res) {
  if (req.xhr || req.path.startsWith('/api/')) {
    return res.status(404).json({ error: 'Not found', code: 'NOT_FOUND' });
  }
  res.status(404).render('404', { title: '404 - Not Found' });
}

module.exports = { errorHandler, notFoundHandler };
