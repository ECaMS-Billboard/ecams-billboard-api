// routes/upload.js

/*
Handles all file uploads from the frontend (/upload endpoint).
This version includes input sanitization, detailed error messages,
and strict control over file types and size limits.

Checks supplied 
Although with that being said, this input sanitisation is still incomplete.

VULNERABILITIES: (From what I know of)

1. No tracking of who uploads what or any timestamps

2. Anyone can upload infinite times
 */

const express = require('express');
const multer = require('multer');
const { Readable } = require('stream');
const crypto = require('crypto');

const router = express.Router();



// Middleware to block uploads when disabled
function checkSubmissionsEnabled(req, res, next) {
  // getSubmissionsEnabled() was attached to app.locals in index.js
  const getFlag = req.app.locals.getSubmissionsEnabled;

  if (typeof getFlag === 'function' && !getFlag()) {
    return res.status(503).json({
      error: 'Flyer submissions are currently disabled by an administrator.'
    });
  }

  next(); // continue if allowed
}

// Multer setup — store files in memory and validate on upload
const storage = multer.memoryStorage();

const upload = multer({
  storage,

  // 5 MB file size limit
  limits: { fileSize: 5 * 1024 * 1024 },

  // Restrict allowed file types to PNG or JPEG
  fileFilter: (req, file, cb) => {
    const allowedMime = ['image/png', 'image/jpeg'];
    const allowedExt = /\.(png|jpg|jpeg)$/i;

    // Check MIME type and extension
    if (!allowedMime.includes(file.mimetype) || !allowedExt.test(file.originalname)) {
      return cb(new Error('INVALID_FILE_TYPE'));
    }

    cb(null, true);
  },
});

function validateMagicNumber(req, res, next) {
  if (!req.file || !req.file.buffer || req.file.buffer.length < 4) {
    return res.status(400).json({ error: 'No file uploaded or file too small.' });
  }

  const buf = req.file.buffer;
  const b0 = buf[0], b1 = buf[1], b2 = buf[2], b3 = buf[3];

  // PNG signature: 0x89 0x50 0x4E 0x47
  const isPNG = b0 === 0x89 && b1 === 0x50 && b2 === 0x4e && b3 === 0x47;

  // JPEG signature: 0xFF 0xD8 0xFF (first three bytes)
  const isJPG = b0 === 0xff && b1 === 0xd8 && b2 === 0xff;

  if (!isPNG && !isJPG) {
    return res.status(400).json({ error: 'Invalid file signature (not a real PNG/JPEG).' });
  }

  // attach detected ext/mime for downstream
  req.detectedExt = isPNG ? '.png' : '.jpg';
  req.detectedMime = isPNG ? 'image/png' : 'image/jpeg';

  next();
}

function sanitizeFilename(originalName = '') {
  // Replace anything not alnum, dot, underscore, hyphen with underscore
  return String(originalName).replace(/[^\w.\-]/g, '_');
}

router.post(
  '/',
  checkSubmissionsEnabled,
  (req, res, next) => {
    console.log('--- Upload request received ---');
    console.log('Body:', req.body);
    console.log('Headers:', req.headers);
    console.log('File present before multer?', req.file);


  // Use multer’s single-file middleware manually, so we can catch its errors
  upload.single('file')(req, res, (err) => {
    if (err instanceof multer.MulterError) {
      if (err.code === 'LIMIT_FILE_SIZE') {
        return res.status(400).json({ error: 'File too large. Max size is 5 MB.' });
      }
      return res.status(400).json({ error: `Upload error: ${err.message}` });
    } else if (err && err.message === 'INVALID_FILE_TYPE') {
      return res.status(400).json({ error: 'Invalid file type. Only PNG and JPEG are allowed.' });
    } else if (err) {
      return res.status(500).json({ error: 'Unexpected upload error.', details: err.message });
    }
    if (!req.file) {
      return res.status(400).json({ error: 'No file uploaded.' });
    }

    next();
  });
}, 
validateMagicNumber,
async (req, res) => {
  // Pull MongoDB and GridFS bucket from app.locals (set in index.js)
  const db = req.app.locals.db;
  const gfsBucket = req.app.locals.gfsBucket;
  console.log('db present?', !!db);
  console.log('gfsBucket present?', !!gfsBucket);

  if (!db || !gfsBucket) {
    console.error('Database or GridFSBucket not initialized yet.');
    return res.status(500).json({ error: 'Database not ready. Please try again later.' });
  }

  try {
      const { description = '', notes = '' } = req.body;

      const sanitizedOriginal = sanitizeFilename(req.file.originalname || 'upload');
      
      // strip any user-supplied extension and force the detected extension
      const base = sanitizedOriginal.replace(/\.[^.]*$/, '') || 'file';
      const finalFilename = `${base}${req.detectedExt}`;

      const readableStream = new Readable();
      readableStream.push(req.file.buffer);
      readableStream.push(null);

      const uploadStream = gfsBucket.openUploadStream(finalFilename, {
        contentType: req.detectedMime,
      });

      readableStream.pipe(uploadStream);

      uploadStream.on('finish', async () => {
        try {
          const file = await db.collection('slides.files').findOne({ filename: finalFilename });

          console.log('GridFS upload finished for file:', finalFilename);

          if (!file) {
            return res.status(500).json({ error: 'Image upload failed' });
          }

          await db.collection('Slides').insertOne({
            filename: file.filename,
            contentType: file.contentType,
            length: file.length,
            uploadDate: file.uploadDate,
            fileId: file._id,
            description: description,
            department: 'N/A',
            notes: notes,
            approved: false,
          });

          return res.status(201).json({
            file,
            message: 'Image uploaded successfully',
            metadata: { description, approved: false }
          });
        } catch (e) {
          console.error('Error after GridFS finish:', e);
          return res.status(500).json({ error: 'Failed to save metadata', details: e.message });
        }
      });

      uploadStream.on('error', (err) => {
        console.error('Upload failed:', err);
        res.status(500).json({ error: 'Failed to upload image', details: err.message });
      });
    } catch (err) {
      console.error('Unexpected error in upload route:', err);
      res.status(500).json({ error: 'Unexpected server error.', details: err.message });
    }
  }
);
module.exports = router;