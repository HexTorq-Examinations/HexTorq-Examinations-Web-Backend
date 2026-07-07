const multer = require('multer');

const fileFilter = (req, file, cb) => {
  if (/^image\/(png|jpe?g|webp|gif)$/.test(file.mimetype)) {
    cb(null, true);
  } else {
    cb(new Error('Only image uploads are allowed'));
  }
};

const uploadAvatar = multer({
  storage: multer.memoryStorage(),
  fileFilter,
  limits: { fileSize: 2 * 1024 * 1024 },
});

module.exports = { uploadAvatar };
