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
        email = '',
        eventDate = '',
        expiresAt = Date.now() + 70 * 24 * 60 * 60 * 1000
      } = req.body;

      let parsedExpiry;

      if (typeof expiresAt === 'number') {
        parsedExpiry = new Date(expiresAt);
      } else if (expiresAt && /^\d{4}-\d{2}-\d{2}$/.test(expiresAt)) {
        parsedExpiry = new Date(expiresAt + 'T23:59:59-08:00');
      } else {
        parsedExpiry = new Date(Date.now() + 70 * 24 * 60 * 60 * 1000);
      }

      // someone can fix this mess if they want at some point. I think this should work. This is needed because the API slide submission and user slide submission are a bit different
      if (!parsedExpiry || isNaN(parsedExpiry.getTime())) {
        parsedExpiry = new Date(Date.now() + 70 * 24 * 60 * 60 * 1000);
      }

      let parsedEventDate = null;

if (eventDate) {
  if (
    typeof eventDate !== 'string' ||
    !/^\d{4}-\d{2}-\d{2}$/.test(eventDate)
  ) {
    return res.status(400).json({
      error: 'Event date must use the YYYY-MM-DD format.'
    });
  }

  const dateParts = eventDate.split('-').map(Number);

  parsedEventDate = new Date(
    Date.UTC(dateParts[0], dateParts[1] - 1, dateParts[2])
  );

  if (
    parsedEventDate.getUTCFullYear() !== dateParts[0] ||
    parsedEventDate.getUTCMonth() !== dateParts[1] - 1 ||
    parsedEventDate.getUTCDate() !== dateParts[2]
  ) {
    return res.status(400).json({
      error: 'Please provide a valid event date.'
    });
  }
}
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
            submittedAt,
            fileId: file._id,
            description,
            department: 'N/A',
            notes,
            email,
            eventDate: parsedEventDate,
            approved: false,
            approvedBy: '',
            displayOrder: 0,
            expiresAt: parsedExpiry,
          });

          return res.status(201).json({
            file,
            message: 'Image uploaded successfully',
            metadata: {
              description,
              notes,
              email,
              eventDate: parsedEventDate,
              approved: false,
              approvedBy: '',
              submittedAt
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


router.post('/screenshot', checkSubmissionsEnabled, express.json(), async (req, res) => {
  const db = req.app.locals.db;
  const gfsBucket = req.app.locals.gfsBucket;

  if (!db || !gfsBucket) {
    return res.status(500).json({ error: 'Database not ready. Please try again later.' });
  }

  if (!process.env.SNAPRENDER_API_KEY) {
    console.error('SNAPRENDER_API_KEY is not set.');
    return res.status(500).json({ error: 'Screenshot service is not configured.' });
  }

  const { url, description = '', notes = '', email = '' } = req.body || {};

  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return res.status(400).json({ error: 'Please provide a valid URL.' });
  }
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    return res.status(400).json({ error: 'Only http(s) URLs are allowed.' });
  }

  try {
    const apiUrl =
      'https://app.snap-render.com/v1/screenshot?' +
      new URLSearchParams({
        url: parsed.href,
        format: 'jpeg',
        width: '1080',
        height: '1080', 
        quality: '85',
        delay: '1000',
        block_cookie_banners: 'true',
        block_ads: 'true',
      });

    const response = await fetch(apiUrl, {
      headers: { 'X-API-Key': process.env.SNAPRENDER_API_KEY },
      signal: AbortSignal.timeout(45000),
    });

    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      throw new Error(`SnapRender returned ${response.status} ${detail}`.trim());
    }

    const buffer = Buffer.from(await response.arrayBuffer());

    if (buffer.length > 5 * 1024 * 1024) {
      return res.status(400).json({ error: 'Screenshot is larger than 5 MB.' });
    }

    const submittedAt = new Date();
    const hostname = parsed.hostname.replace(/[^\w.\-]/g, '_');
    const finalFilename = `screenshot-${hostname}-${Date.now()}.jpg`;

    const uploadStream = gfsBucket.openUploadStream(finalFilename, {
      contentType: 'image/jpeg',
    });

    await new Promise((resolve, reject) => {
      Readable.from(buffer).pipe(uploadStream).on('finish', resolve).on('error', reject);
    });

    const file = await db.collection('slides.files').findOne({ _id: uploadStream.id });

    if (!file) {
      return res.status(500).json({ error: 'Image upload failed' });
    }

    await db.collection('Slides').insertOne({
      filename: file.filename,
      contentType: file.contentType,
      length: file.length,
      uploadDate: file.uploadDate,
      submittedAt,
      fileId: file._id,
      description,
      department: 'N/A',
      notes,
      email,
      eventDate: null,
      approved: true,
      approvedBy: 'SUBMITTED VIA API SCREENSHOT',
      displayOrder: 0,
      expiresAt: new Date(Date.now() + 70 * 24 * 60 * 60 * 1000),
    });

    return res.status(201).json({
      file,
      message: 'Screenshot uploaded successfully',
      metadata: { description, notes, email, approved: false, approvedBy: '', submittedAt },
    });
  } catch (err) {
    console.error('Screenshot failed:', err);
    return res.status(500).json({ error: 'Failed to capture screenshot.', details: err.message });
  }
});


const AUTO_APPROVER = 'SUBMITTED VIA API SCREENSHOT';
const AUTO_MAX_AGE_MS = 24 * 60 * 60 * 1000;

router.post('/screenshot/auto', async (req, res) => {
  const db = req.app.locals.db;
  const gfsBucket = req.app.locals.gfsBucket;

  if (!db || !gfsBucket) {
    return res.status(500).json({ error: 'Database not ready.' });
  }
  if (!process.env.SNAPRENDER_API_KEY) {
    return res.status(500).json({ error: 'Screenshot service is not configured.' });
  }

  try {
    // All calendar slides, newest first
    const olds = await db
      .collection('Slides')
      .find({ approvedBy: AUTO_APPROVER })
      .sort({ submittedAt: -1 })
      .toArray();
    const newest = olds[0];

    if (newest?.submittedAt && Date.now() - new Date(newest.submittedAt).getTime() < AUTO_MAX_AGE_MS) {
      return res.status(200).json({ message: 'Slide not older than 1 day.' });
    }

    // Take the screenshot
    const apiUrl =
      'https://app.snap-render.com/v1/screenshot?' +
      new URLSearchParams({
        url: 'https://mango-water-0e83db20f.7.azurestaticapps.net/calendar',
        format: 'jpeg',
        width: '1080',
        height: '1080', 
        quality: '85',
        delay: '3000', 
      });

    const response = await fetch(apiUrl, {
      headers: { 'X-API-Key': process.env.SNAPRENDER_API_KEY },
      signal: AbortSignal.timeout(45000),
    });
    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      throw new Error(`SnapRender returned ${response.status} ${detail}`.trim());
    }

   const buffer = Buffer.from(await response.arrayBuffer());

    // Save the new image
    const uploadStream = gfsBucket.openUploadStream(`auto-screenshot-${Date.now()}.jpg`, {
      contentType: 'image/jpeg',
    });
    await new Promise((resolve, reject) => {
      Readable.from(buffer).pipe(uploadStream).on('finish', resolve).on('error', reject);
    });
    const file = await db.collection('slides.files').findOne({ _id: uploadStream.id });
    if (!file) throw new Error('Image upload failed');

    // Create the new slide first, so a failure never leaves you with nothing.
    // It keeps the old slide's department and position.
    await db.collection('Slides').insertOne({
      filename: file.filename,
      contentType: file.contentType,
      length: file.length,
      uploadDate: file.uploadDate,
      submittedAt: new Date(),
      fileId: file._id,
      description: 'Auto-refreshing screenshot',
      department: newest?.department || 'N/A',
      notes: '',
      email: '',
      eventDate: null,
      approved: true,
      approvedBy: 'SUBMITTED VIA API SCREENSHOT',
      displayOrder: newest?.displayOrder ?? 0,
      expiresAt: new Date(Date.now() + 70 * 24 * 60 * 60 * 1000),
    });

    // Purge the old calendar slide(s) and their images
    for (const old of olds) {
      await db.collection('Slides').deleteOne({ _id: old._id });
      await gfsBucket.delete(old.fileId).catch((e) =>
        console.error('Could not delete old image:', e.message)
      );
    }

    return res.status(newest ? 200 : 201).json({
      message: newest ? 'Calendar slide replaced.' : 'Calendar slide created.',
      fileId: file._id,
    });
  } catch (err) {
    console.error('Auto screenshot failed:', err);
    return res.status(500).json({ error: 'Failed to refresh screenshot.', details: err.message });
  }
});

export default router;