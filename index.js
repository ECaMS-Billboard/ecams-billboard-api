require('dotenv').config();
const express = require('express');
const cors = require('cors');
const mongoose = require('mongoose'); // MongoDB
const multer = require('multer'); // For GridFS
const { Readable } = require('stream');
const path = require('path');

const app = express();
const PORT = 5000;

// Open up CORS
app.use(cors({ origin: '*' }));
app.use(express.json());

// Connect to MongoDB
mongoose.connect(process.env.MONGO_URI, {
  useNewUrlParser: true,
  useUnifiedTopology: true,
});

// Specify the EcamsBB Database
const db = mongoose.connection.useDb('EcamsBB');

// Initialize GridFS
let gfsBucket;
db.once('open', () => {
  gfsBucket = new mongoose.mongo.GridFSBucket(db.db, {
    bucketName: 'slides',
  });
  console.log('GridFSBucket for "slides" initialized.');
});

// Configuration for file uploads
const storage = multer.memoryStorage();
const upload = multer({ storage });

// MongoDB model for the professor data
const User = db.model(
  'User',
  new mongoose.Schema({
    First: String,
    Last: String,
    Email: String,
  }),
  'Professors'
);

// Serve index.html as the static
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

// Route to return the list of all professors
app.get('/prof-list', async (req, res) => {
  try {
    const users = await User.find();
    console.log('Professors:', users);

    if (users.length === 0) {
      return res.status(404).json({ message: 'No professors found.' });
    }

    res.json(users);
  } catch (err) {
    console.error('Failed to fetch professors:', err);
    res.status(500).json({ error: 'Failed to fetch professors' });
  }
});

// Route to add a professor to the list
app.post('/add-prof', async (req, res) => {
  try {
    const newProfessor = new User({
      First: 'Example',
      Last: 'Name',
      Email: 'example.name@example.com',
    });

    await newProfessor.save();
    res.status(201).json({ message: 'Professor added successfully' });
  } catch (err) {
    console.error('Failed to add professor:', err);
    res.status(500).json({ error: 'Failed to add professor' });
  }
});

// Route to upload an image to MongoDB using GridFS
app.post('/upload', upload.single('file'), async (req, res) => {
    if (!req.file) {
      return res.status(400).json({ error: 'No file uploaded' });
    }
  
    try {
      // Marks these as optional fields from the request
      const { description = '', notes = '' } = req.body;
  
      const readableStream = new Readable();
      readableStream.push(req.file.buffer);
      readableStream.push(null);
  
      const uploadStream = gfsBucket.openUploadStream(req.file.originalname, {
        contentType: req.file.mimetype,
      });
  
      readableStream.pipe(uploadStream);
  
      uploadStream.on('finish', async () => {
        const file = await db.collection('slides.files').findOne({
          filename: req.file.originalname,
        });
  
        if (!file) {
          return res.status(500).json({ error: 'File upload failed' });
        }
  
        // Insert metadata including optional Description and Notes
        await db.collection('Slides').insertOne({
          filename: file.filename,
          contentType: file.contentType,
          length: file.length,
          uploadDate: file.uploadDate,
          fileId: file._id,
          Description: description, // Optional description
          Notes: notes, // Optional other notes
          Approved: 'No', // All slides are NOT approved by default
        });
  
        res.status(201).json({ 
          file, 
          message: 'Image uploaded successfully',
          metadata: { description, notes, approved: 'No' }
        });
      });
  
      uploadStream.on('error', (err) => {
        console.error('Upload failed:', err);
        res.status(500).json({ error: 'Failed to upload image', details: err });
      });
    } catch (err) {
      console.error('Unexpected error during upload:', err);
      res.status(500).json({ error: 'Unexpected error occurred', details: err });
    }
  });  

// Route to fetch an image by filename
app.get('/image/:filename', async (req, res) => {
  try {
    const { filename } = req.params;
    const file = await db.collection('slides.files').findOne({ filename });

    if (!file) {
      console.log(`File not found: ${filename}`);
      return res.status(404).json({ error: `File not found: ${filename}` });
    }

    const readStream = gfsBucket.openDownloadStreamByName(filename);
    res.set('Content-Type', file.contentType);
    readStream.pipe(res);
  } catch (err) {
    console.error('Error fetching image:', err);
    res.status(500).json({ error: 'Failed to fetch image', details: err });
  }
});

// Route to return all images (as JSON)
app.get('/list-images', async (req, res) => {
    try {
      const files = await db.collection('slides.files').find().toArray();
      if (!files || files.length === 0) {
        return res.status(404).json({ message: 'No images found.' });
      }
      res.json(files);
    } catch (err) {
      console.error('Failed to list images:', err);
      res.status(500).json({ error: 'Failed to list images', details: err });
    }
  });  

// Start the server
app.listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT}`);
});