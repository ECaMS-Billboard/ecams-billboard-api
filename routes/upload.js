// routes/upload.js
//
// Handles all file uploads from the frontend (/upload endpoint).
// This version includes input sanitization, detailed error messages,
// and strict control over file types and size limits.

const express = require('express');
const multer = require('multer');
const { Readable } = require('stream');
const router = express.Router();

// -------------------------------------------------------------
// Multer setup — store files in memory and validate on upload
// -------------------------------------------------------------
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

// -------------------------------------------------------------
// Upload route — receives POST /upload
// -------------------------------------------------------------
router.post('/', (req, res, next) => {
  console.log('--- Upload request received ---');
  console.log('Body:', req.body);
  console.log('Headers:', req.headers);
  console.log('File present before multer?', req.file);


  // Use multer’s single-file middleware manually, so we can catch its errors
  upload.single('file')(req, res, (err) => {
    if (err instanceof multer.MulterError) {
      // Handle Multer-specific errors (like file size limit)
      if (err.code === 'LIMIT_FILE_SIZE') {
        return res.status(400).json({ error: 'File too large. Max size is 5 MB.' });
      }
      return res.status(400).json({ error: `Upload error: ${err.message}` });
    } else if (err && err.message === 'INVALID_FILE_TYPE') {
      // Custom error for invalid image types
      return res.status(400).json({ error: 'Invalid file type. Only PNG and JPEG are allowed.' });
    } else if (err) {
      // Catch-all for unexpected multer errors
      return res.status(500).json({ error: 'Unexpected upload error.', details: err.message });
    }

    // If no file was provided at all
    if (!req.file) {
      return res.status(400).json({ error: 'No file uploaded.' });
    }

    // If validation passes, proceed to upload
    next();
  });
}, async (req, res) => {
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

    // Sanitize filename to prevent special character abuse
    const sanitizedFilename = req.file.originalname.replace(/[^\w.\-]/g, '_');

    // Create a readable stream from the uploaded file buffer
    const readableStream = new Readable();
    readableStream.push(req.file.buffer);
    readableStream.push(null);

    // Open a GridFS upload stream for this file
    const uploadStream = gfsBucket.openUploadStream(sanitizedFilename, {
      contentType: req.file.mimetype,
    });

    // Pipe the uploaded file data into MongoDB’s GridFS
    readableStream.pipe(uploadStream);

    // Handle success
    uploadStream.on('finish', async () => {
      const file = await db.collection('slides.files').findOne({ filename: sanitizedFilename });
      console.log('GridFS upload finished for file:', sanitizedFilename);

      if (!file) {
        return res.status(500).json({ error: 'File upload failed unexpectedly.' });
      }

      // Store metadata in a separate collection
      await db.collection('Slides').insertOne({
        filename: file.filename,
        contentType: file.contentType,
        length: file.length,
        uploadDate: file.uploadDate,
        fileId: file._id,
        description,
        department: 'N/A',
        notes,
        approved: false,
      });

      return res.status(201).json({
        message: 'Image uploaded successfully.',
        metadata: { filename: sanitizedFilename, approved: false },
      });
    });

    // Handle upload errors during streaming
    uploadStream.on('error', (err) => {
      console.error('GridFS upload error:', err);
      res.status(500).json({ error: 'Failed to upload image.', details: err.message });
    });

  } catch (err) {
    console.error('Unexpected error in upload route:', err);
    res.status(500).json({ error: 'Unexpected server error.', details: err.message });
    console.error('GridFS upload stream failed:', err);
  }
});

module.exports = router;