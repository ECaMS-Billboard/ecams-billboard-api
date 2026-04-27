// routes/upload.js

/*
Handles all file uploads from the frontend (/upload endpoint).
This version includes input sanitization, detailed error messages,
strict control over file types and size limits, uploader email,
and upload/submission date tracking.
*/

import express from 'express';
import multer from 'multer';
import { Readable } from 'stream';

const router = express.Router();

// Middleware to block uploads when disabled
function checkSubmissionsEnabled(req, res, next) {
  const getFlag = req.app.locals.getSubmissionsEnabled;

  if (typeof getFlag === 'function' && !getFlag()) {
    return res.status(503).json({
      error: 'Flyer submissions are currently disabled by an administrator.'
    });
  }

  next();
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

  // JPEG signature: 0xFF 0xD8 0xFF
  const isJPG = b0 === 0xff && b1 === 0xd8 && b2 === 0xff;

  if (!isPNG && !isJPG) {
    return res.status(400).json({ error: 'Invalid file signature. Only real PNG/JPEG files are allowed.' });
  }

  req.detectedExt = isPNG ? '.png' : '.jpg';
  req.detectedMime = isPNG ? 'image/png' : 'image/jpeg';

  next();
}

function sanitizeFilename(originalName = '') {
  return String(originalName).replace(/[^\w.\-]/g, '_');
}

router.post(
  '/',
  checkSubmissionsEnabled,
  (req, res, next) => {
    upload.single('file')(req, res, (err) => {
      if (err instanceof multer.MulterError) {
        if (err.code === 'LIMIT_FILE_SIZE') {
          return res.status(400).json({ error: 'File too large. Max size is 5 MB.' });
        }

        return res.status(400).json({ error: `Upload error: ${err.message}` });
      }

      if (err && err.message === 'INVALID_FILE_TYPE') {
        return res.status(400).json({ error: 'Invalid file type. Only PNG and JPEG are allowed.' });
      }

      if (err) {
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
    const db = req.app.locals.db;
    const gfsBucket = req.app.locals.gfsBucket;

    if (!db || !gfsBucket) {
      console.error('Database or GridFSBucket not initialized yet.');
      return res.status(500).json({ error: 'Database not ready. Please try again later.' });
    }

    try {
      const {
        description = '',
        notes = '',
        email = ''
      } = req.body;

      const submittedAt = new Date();

      const sanitizedOriginal = sanitizeFilename(req.file.originalname || 'upload');

      // Strip user extension and force the detected extension
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

          if (!file) {
            return res.status(500).json({ error: 'Image upload failed' });
          }

          await db.collection('Slides').insertOne({
            filename: file.filename,
            contentType: file.contentType,
            length: file.length,
            uploadDate: file.uploadDate,
            submittedAt: submittedAt,
            fileId: file._id,
            description: description,
            department: 'N/A',
            notes: notes,
            email: email,
            approved: false,
            approvedBy: '',
          });

          return res.status(201).json({
            file,
            message: 'Image uploaded successfully',
            metadata: {
              description,
              email,
              approved: false,
              approvedBy: '',
              submittedAt: submittedAt
            }
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

export default router;