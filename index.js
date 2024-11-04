const express = require('express');
const cors = require('cors'); // Import CORS
const mongoose = require('mongoose');
const path = require('path');
const multer = require('multer'); // For GridFS
const { Readable } = require('stream');

// Create Express application
const app = express();
const port = process.env.PORT || 3000;
app.use(cors()); // Allow CORS

// Use files from the static folder
app.use(express.static(path.join(__dirname, 'static')));

// MongoURI - Ensure to use an environment variable for better security in production
const MONGO_URI = "mongodb+srv://ecamsbb:0JqIEtTsol8lXab1@ecamsdb.kk917.mongodb.net/?retryWrites=true&w=majority&appName=EcamsBB";
console.log("MONGO_URI:", MONGO_URI);

// Connect to MongoDB
mongoose.connect(MONGO_URI, {
    useNewUrlParser: true,
    useUnifiedTopology: true,
  });
  
  const db = mongoose.connection.useDb('EcamsBB');
  
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

// Route to return the list of all professors
app.get('/prof-list', async (req, res) => {
    try {
      const users = await User.find();
      console.log('Professors:', users);
  
      if (users.length === 0) {
        return res.status(200).json({ message: 'No professors found.', users: [] });
      }    
  
      res.json(users);
    } catch (err) {
      console.error('Failed to fetch professors:', err);
      res.status(500).json({ error: 'Failed to fetch professors' });
    }
  });

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

// Route to upload an image to MongoDB using GridFS
app.post('/upload', upload.single('file'), async (req, res) => {
    if (!req.file) {
      return res.status(400).json({ error: 'No file uploaded' });
    }
  
    try {
      const { description = '', notes = '' } = req.body;
      const readableStream = new Readable();
      readableStream.push(req.file.buffer);
      readableStream.push(null);
  
      const uploadStream = gfsBucket.openUploadStream(req.file.originalname, {
        contentType: req.file.mimetype,
      });
  
      readableStream.pipe(uploadStream);
  
      uploadStream.on('finish', async () => {
        const file = await db.collection('slides.files').findOne({ filename: req.file.originalname });
  
        if (!file) {
          return res.status(500).json({ error: 'File upload failed' });
        }
  
        await db.collection('Slides').insertOne({
          filename: file.filename,
          contentType: file.contentType,
          length: file.length,
          uploadDate: file.uploadDate,
          fileId: file._id,
          description: description,
          notes: notes,
          approved: false, // All slides are NOT approved by default
        });
  
        res.status(201).json({
          file,
          message: 'Image uploaded successfully',
          metadata: { description, approved: false }
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

// Custom 404 page
app.use((req, res) => {
    res.type('text/plain')
    res.status(404)
    res.send('404 - Not Found')
})

// Custom 500 page
app.use((err, req, res, next) => {
    console.error(err.message)
    res.type('text/plain')
    res.status(500)
    res.send('500 - Server Error')
})

// Start the server
app.listen(port, () => {
    console.log(`Server started on port ${port}`);
});
