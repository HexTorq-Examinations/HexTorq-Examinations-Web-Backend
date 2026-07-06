const multer = require('multer');
const ApiError = require('../utils/ApiError');
const logger = require('../lib/logger');
const { trackError } = require('../utils/errorTracking');

function notFoundHandler(req, res, next) {
  next(new ApiError(404, `Route not found: ${req.method} ${req.originalUrl}`));
}

function errorHandler(err, req, res, next) {
  if (err instanceof multer.MulterError || /only \.(xlsx|xls|csv)|only image uploads/i.test(err.message || '')) {
    return res.status(400).json({ message: err.message || 'File upload failed' });
  }

  const statusCode = err instanceof ApiError ? err.statusCode : (err.statusCode || 500);
  if (!(err instanceof ApiError)) {
    logger.error({ err, method: req.method, path: req.originalUrl, userId: req.user?.id }, 'unhandled request error');
  }
  if (statusCode >= 500) trackError(err, req, statusCode);
  res.status(statusCode).json({
    message: err.message || 'Internal server error',
    ...(err.code ? { code: err.code } : {}),
    ...(err.details ? { details: err.details } : {}),
  });
}

module.exports = { notFoundHandler, errorHandler };
