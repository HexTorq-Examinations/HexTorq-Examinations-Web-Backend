const multer = require('multer');
const ApiError = require('../utils/ApiError');

function notFoundHandler(req, res, next) {
  next(new ApiError(404, `Route not found: ${req.method} ${req.originalUrl}`));
}

function errorHandler(err, req, res, next) {
  if (err instanceof multer.MulterError || /only \.(xlsx|xls|csv)|only image uploads/i.test(err.message || '')) {
    return res.status(400).json({ message: err.message || 'File upload failed' });
  }

  const statusCode = err instanceof ApiError ? err.statusCode : (err.statusCode || 500);
  if (!(err instanceof ApiError)) {
    console.error(err);
  }
  res.status(statusCode).json({
    message: err.message || 'Internal server error',
  });
}

module.exports = { notFoundHandler, errorHandler };
