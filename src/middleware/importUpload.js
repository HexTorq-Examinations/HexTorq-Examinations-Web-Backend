const multer = require('multer');
const path = require('path');

const ALLOWED_EXTENSIONS = new Set(['.xlsx', '.csv']);

const storage = multer.memoryStorage();

const fileFilter = (req, file, cb) => {
  const ext = path.extname(file.originalname).toLowerCase();
  if (!ALLOWED_EXTENSIONS.has(ext)) {
    return cb(new Error('Only .xlsx or .csv files are allowed'));
  }
  cb(null, true);
};

const uploadQuestionsFile = multer({
  storage,
  fileFilter,
  limits: { fileSize: 5 * 1024 * 1024, files: 1 },
});

module.exports = { uploadQuestionsFile };
