const express = require('express');
const cors = require('cors'); // Import CORS
const mongoose = require('mongoose');
const path = require('path');
const multer = require('multer'); // For GridFS
const { Readable } = require('stream');
const session = require('express-session'); // Import express-session
const passport = require('passport'); // Import passport
const GoogleStrategy = require('passport-google-oauth20').Strategy; // Import Google OAuth strategy
const fs = require('fs');


// Create Express application
const app = express();
const port = process.env.PORT || 3000;
app.use(cors()); // Allow CORS

// Use files from the static folder
app.use(express.static(path.join(__dirname, 'static')));

// Include JSON middleware (for /login)
app.use(express.json());

require('dotenv').config();

// Middleware to protect routes
function isAuthenticated(req, res, next) {
    if (req.isAuthenticated && req.isAuthenticated()) {
        return next();
    }
    return res.redirect('/auth/google');
}

// ===== Flyer submissions feature flag (file-backed) =====
const FLAG_FILE = path.join(__dirname, 'feature-flags.json');

function ensureFlagFile() {
    if (!fs.existsSync(FLAG_FILE)) {
        fs.writeFileSync(
            FLAG_FILE,
            JSON.stringify({ submissionsEnabled: true }, null, 2)
        );
    }
}

function getSubmissionsEnabled() {
    try {
        ensureFlagFile();
        const data = JSON.parse(fs.readFileSync(FLAG_FILE, 'utf-8'));
        return !!data.submissionsEnabled;
    } catch {
        return true; // fail-open if unreadable
    }
}

function setSubmissionsEnabled(enabled) {
    ensureFlagFile();
    fs.writeFileSync(
        FLAG_FILE,
        JSON.stringify({ submissionsEnabled: !!enabled }, null, 2)
    );
    return !!enabled;
}

// Expose for routers (e.g., routes/upload.js)
app.locals.getSubmissionsEnabled = getSubmissionsEnabled;

// Session setup for authentication
app.use(session({
    secret: process.env.SESSION_SECRET,
    resave: false,
    saveUninitialized: true,
}));
app.use(passport.initialize());
app.use(passport.session());

// === Admin API to read/update the flag ===
app.get('/api/admin/submissions/enabled', isAuthenticated, (req, res) => {
    try {
        res.json({ submissionsEnabled: getSubmissionsEnabled() });
    } catch (e) {
        console.error('Read flag failed:', e);
        res.status(500).json({ error: 'Unable to read feature flag' });
    }
});

app.put('/api/admin/submissions/enabled', isAuthenticated, (req, res) => {
    try {
        const { enabled } = req.body;
        if (typeof enabled !== 'boolean') {
            return res.status(400).json({ error: '`enabled` must be boolean' });
        }
        const updated = setSubmissionsEnabled(enabled);
        res.json({ submissionsEnabled: updated });
    } catch (e) {
        console.error('Write flag failed:', e);
        res.status(500).json({ error: 'Unable to update feature flag' });
    }
});

// MongoURI - Ensure to use an environment variable for better security in production
const MONGO_URI = process.env.MONGO_URI;

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
        fname: String,
        lname: String,
        email: String,
        dept: String,
        office: String,
        num_ratings: { type: Number, default: 0 },
        overall_rating: { type: String, default: '0' },
        image: String, // New field for image
    }),
    'Professors'
);

// This allows users to be added for mongo
const AllowedEmail = db.model(
    'AllowedEmail',
    new mongoose.Schema({
        email: { type: String, required: true, unique: true }
    }),
    'AllowedEmails'
);

// Authentication code
// Passport configuration
passport.use(new GoogleStrategy({
    clientID: process.env.CLIENT_ID,
    clientSecret: process.env.CLIENT_SECRET,
    callbackURL: "/auth/google/callback"
},
    async (accessToken, refreshToken, profile, done) => {
        const userEmail = profile.emails[0].value; // Get the user's email

        // Check if the user is allowed
        const allowedUser = await AllowedEmail.findOne({ email: userEmail });
        if (allowedUser) {
            return done(null, profile); // User is allowed
        } else {
            return done(null, false, { message: 'Unauthorized user' }); // User is not allowed
        }
    }));

passport.serializeUser((user, done) => {
    done(null, user);
});

passport.deserializeUser((user, done) => {
    done(null, user);
});

// Authentication routes
app.get('/auth/google', passport.authenticate('google', {
    scope: ['profile', 'email']
}));

app.get('/auth/google/callback',
    passport.authenticate('google', { failureRedirect: '/' }),
    (req, res) => {
        if (req.user) {
            res.redirect('/'); // Redirect to a protected route
        } else {
            res.status(403).send('Access denied: You are not authorized to access this site.');
        }
    }
);

app.get('/logout', (req, res) => {
    req.logout((err) => {
        if (err) {
            console.error('Logout error:', err); // Log the error for debugging
            return res.status(500).send('Logout failed'); // Send a response indicating failure
        }
        console.log('User logged out:', req.user); // Should be undefined after logout
        res.redirect('/'); // Redirect to home after logout
    });
});

// Check authentication status
app.get('/api/check-auth', (req, res) => {
    if (req.isAuthenticated()) {
        return res.status(200).json({ authenticated: true });
    }
    res.status(401).json({ authenticated: false });
});

// Home page route
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'static', 'index.html'));
});

// Professors page route
app.get('/professors', isAuthenticated, (req, res) => {
    res.sendFile(path.join(__dirname, 'static', 'professors.html'));
});

// Slides page route
app.get('/slides', isAuthenticated, (req, res) => {
    res.sendFile(path.join(__dirname, 'static', 'slides.html'));
});

app.get('/users', isAuthenticated, (req, res) => {
    res.sendFile(path.join(__dirname, 'static', 'users.html'));
});

// Admin dashboard route (for layout.html)
app.get('/admin', isAuthenticated, (req, res) => {
    res.sendFile(path.join(__dirname, 'static', 'layout.html'));
});


// Configuration for file uploads
const storage = multer.memoryStorage();
const upload = multer({ storage });

// Route to add an allowed email
app.post('/add-allowed-email', isAuthenticated, async (req, res) => {
    const { email } = req.body;
    try {
        const newEmail = new AllowedEmail({ email });
        await newEmail.save();
        res.status(201).json({ message: 'Email added successfully' });
    } catch (err) {
        console.error('Failed to add email:', err);
        res.status(500).json({ error: 'Failed to add email' });
    }
});

// Route to delete an allowed email
app.delete('/delete-allowed-email/:id', isAuthenticated, async (req, res) => {
    try {
        const email = await AllowedEmail.findByIdAndDelete(req.params.id);
        if (!email) {
            return res.status(404).json({ error: 'Email not found' });
        }
        res.json({ message: 'Email deleted successfully' });
    } catch (err) {
        console.error('Failed to delete email:', err);
        res.status(500).json({ error: 'Failed to delete email' });
    }
});

// Route to list all allowed emails
app.get('/allowed-emails', isAuthenticated, async (req, res) => {
    try {
        const emails = await AllowedEmail.find();
        res.json(emails);
    } catch (err) {
        console.error('Failed to fetch allowed emails:', err);
        res.status(500).json({ error: 'Failed to fetch allowed emails' });
    }
});
//Limit to proffessor images-> not more than 2 MB
const uploadProfessorImage = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 2 * 1024 * 1024 } // 2 MB
});
function handleUploadError(err, _req, res, next) {
    if (err instanceof multer.MulterError && err.code === 'LIMIT_FILE_SIZE') {
        return res.status(400).json({ error: 'Image cannot be larger than 2 MB' });
    }
    next(err);
}

// Route to upload a professor with an image
app.post('/add-professor', isAuthenticated, uploadProfessorImage.single('image'), handleUploadError, async (req, res) => {  //before upload.single('image'), now using limit 
    try {
        const { fname, lname, email, dept, office } = req.body;

        // Create a readable stream from the uploaded file
        const readableStream = new Readable();
        readableStream.push(req.file.buffer);
        readableStream.push(null);

        // Upload the image to GridFS
        const uploadStream = gfsBucket.openUploadStream(req.file.originalname, {
            contentType: req.file.mimetype,
        });

        readableStream.pipe(uploadStream);

        uploadStream.on('finish', async () => {
            const file = await db.collection('slides.files').findOne({ filename: req.file.originalname });

            if (!file) {
                return res.status(500).json({ error: 'Image upload failed' });
            }

            // Create a new professor with the image fileId
            const newProfessor = new User({
                fname,
                lname,
                email,
                dept,
                office,
                image: file._id, // Save the image fileId
            });
            await newProfessor.save();
            res.status(201).json({ message: 'Professor added successfully' });
        });

        uploadStream.on('error', (err) => {
            console.error('Upload failed:', err);
            res.status(500).json({ error: 'Failed to upload image', details: err });
        });
    } catch (err) {
        console.error('Failed to add professor:', err);
        res.status(500).json({ error: 'Failed to add professor' });
    }
});

// Route to edit the professor info
app.put('/edit-professor/:id', isAuthenticated, uploadProfessorImage.single('image'), handleUploadError, async (req, res) => {  //change in uploading from upload.single('image') to limit
    try {
        const { fname, lname, email, dept, office } = req.body;
        const updateData = { fname, lname, email, dept, office };

        if (req.file) {
            // Create a readable stream from the uploaded file
            const readableStream = new Readable();
            readableStream.push(req.file.buffer);
            readableStream.push(null);

            // Upload the new image to GridFS
            const uploadStream = gfsBucket.openUploadStream(req.file.originalname, {
                contentType: req.file.mimetype,
            });

            readableStream.pipe(uploadStream);

            uploadStream.on('finish', async () => {
                const file = await db.collection('slides.files').findOne({ filename: req.file.originalname });

                if (!file) {
                    return res.status(500).json({ error: 'Image upload failed' });
                }

                updateData.image = file._id; // Update image fileId

                // Update the professor's data with the new image ID
                const professor = await User.findByIdAndUpdate(req.params.id, updateData, { new: true });
                if (!professor) {
                    return res.status(404).json({ error: 'Professor not found' });
                }
                res.json({ message: 'Professor updated successfully' });
            });

            uploadStream.on('error', (err) => {
                console.error('Upload failed:', err);
                return res.status(500).json({ error: 'Failed to upload image', details: err });
            });
        } else {
            // If no new image is uploaded, just update the other fields
            const professor = await User.findByIdAndUpdate(req.params.id, updateData, { new: true });
            if (!professor) {
                return res.status(404).json({ error: 'Professor not found' });
            }
            res.json({ message: 'Professor updated successfully' });
        }
    } catch (err) {
        console.error('Failed to edit professor:', err);
        res.status(500).json({ error: 'Failed to edit professor' });
    }
});

// Route to delete professor info
app.delete('/delete-professor/:id', isAuthenticated, async (req, res) => {
    try {
        const professor = await User.findByIdAndDelete(req.params.id);
        if (!professor) {
            return res.status(404).json({ error: 'Professor not found' });
        }
        res.json({ message: 'Professor deleted successfully' });
    } catch (err) {
        console.error('Failed to delete professor:', err);
        res.status(500).json({ error: 'Failed to delete professor' });
    }
});
//format for azure blob pictures name convention
function formatImageName(fname, lname) {
    return `${fname}_${lname}`
        .toLowerCase()
        .replace(/\s+/g, "_")
        .replace(/[^a-z0-9_]/g, "");
}

module.exports = formatImageName;

// Route to return the list of all professors with images
app.get('/prof-list', async (req, res) => {
    try {
        const users = await User.find({}, '-image'); //Prof images temporarily disabled | Originally: "const users = await User.find();"
        console.log('Professors:', users);
        if (users.length === 0) {
            return res.status(200).json({ message: 'No professors found.', users: [] });
        }
        const usersWithBlobImages = users.map(u => {
            const imgName = formatImageName(u.fname, u.lname);
            return {
                ...u.toObject(),
                imageUrl: `https://ecamsblobstorageaccount.blob.core.windows.net/prof-images/${imgName}.png`
            };
        });

        res.json(usersWithBlobImages);
        //res.json(users);
    } catch (err) {
        console.error('Failed to fetch professors:', err);
        res.status(500).json({ error: 'Failed to fetch professors' });
    }
});

// Route to get data about a specific professor
app.get('/prof-info/:id', async (req, res) => {
    try {
        const professor = await User.findById(req.params.id, '-image'); // Prof images temporarily disabled | Ofiginally: "const professor = await User.findById(req.params.id);"
        if (!professor) {
            return res.status(404).json({ error: 'Professor not found' });
        }
        const imgName = formatImageName(professor.fname, professor.lname);

        res.json({
            ...professor.toObject(),
            imageUrl: `https://ecamsblobstorageaccount.blob.core.windows.net/prof-images/${imgName}.png`
        });
        //res.json(professor);
    } catch (error) {
        console.error('Error fetching professor:', error.message);
        res.status(500).json({ error: 'An error occurred while fetching the data' });
    }
});

// Initialize GridFS
let gfsBucket;
db.once('open', () => {
    gfsBucket = new mongoose.mongo.GridFSBucket(db.db, {
        bucketName: 'slides',
    });
    app.locals.gfsBucket = gfsBucket;
    app.locals.db = db;
    console.log('GridFSBucket for "slides" initialized.');
});

// /uploads gets redirected to routes/upload.js
const uploadRoutes = require('./routes/upload');
app.use('/upload', uploadRoutes);


// Route to upload an image to MongoDB using GridFS

/*
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
              department: 'N/A',
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
*/

// Route to delete an image from MongoDB
app.delete('/delete-slide/:id', isAuthenticated, async (req, res) => {
    try {
        const { id } = req.params;
        const file = await db.collection('slides.files').findOne({ _id: new mongoose.Types.ObjectId(id) });

        if (!file) {
            return res.status(404).json({ error: 'File not found' });
        }

        // Delete the file from GridFS
        await gfsBucket.delete(file._id);

        // Remove the metadata from the Slides collection
        await db.collection('Slides').deleteOne({ fileId: file._id });

        res.json({ message: 'Slide deleted successfully' });
    } catch (err) {
        console.error('Failed to delete slide:', err);
        res.status(500).json({ error: 'Failed to delete slide', details: err });
    }
});

/* TODO: both this and AdminPanel.js on the main repo are both to be considered
   just proof of concept. This (kind of, barely) works as an authentication
   system but it is very very bad, and needs to be reworked ASAP */
const ACP_PASSWORD = process.env.ACP_PASSWORD;

app.post('/login', (req, res) => {
    const { password } = req.body;

    if (!password) {
        return res.status(400).json({
            success: false,
            message: "Password is required"
        });
    }

    if (password !== ACP_PASSWORD) {
        return res.status(401).json({
            success: false,
            message: "Invalid password"
        });
    }

    return res.status(200).json({
        success: true,
        message: "Login successful"
    });
});


// Route to fetch an image by fileId
app.get('/image/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const file = await db.collection('slides.files').findOne({ _id: new mongoose.Types.ObjectId(id) });

        if (!file) {
            console.log(`File not found: ${id}`);
            return res.status(404).json({ error: `File not found: ${id}` });
        }

        const readStream = gfsBucket.openDownloadStream(file._id);
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
        const slides = await db.collection('Slides').find().toArray();
        if (!slides || slides.length === 0) {
            return res.status(404).json({ message: 'No images found.' });
        }
        res.json(slides); // Return slides instead of files
    } catch (err) {
        console.error('Failed to list images:', err);
        res.status(500).json({ error: 'Failed to list images', details: err });
    }
});

// list of all approved images only for display
app.get('/list-approved-images', async (req, res) => {
    try {
        const approvedSlides = await db.collection('Slides').find({ approved: true }).toArray();
        if (!approvedSlides || approvedSlides.length === 0) {
            return res.status(200).json({ message: 'No approved slides found.' });
        }
        res.json(approvedSlides);
    } catch (err) {
        console.error('Failed to list approved slides:', err);
        res.status(500).json({ error: 'Failed to list approved slides', details: err });
    }
});

// This is for approving slides
app.put('/approve-slide/:id', isAuthenticated, async (req, res) => {
    try {
        const { id } = req.params;
        const slide = await db.collection('Slides').updateOne(
            { fileId: new mongoose.Types.ObjectId(id) },
            { $set: { approved: true } }
        );

        if (!slide.matchedCount) {
            return res.status(404).json({ error: 'Slide not found' });
        }

        res.json({ message: 'Slide approved successfully' });
    } catch (err) {
        console.error('Failed to approve slide:', err);
        res.status(500).json({ error: 'Failed to approve slide' });
    }
});

// This is for declining slides
app.put('/decline-slide/:id', isAuthenticated, async (req, res) => {
    try {
        const { id } = req.params;
        const slide = await db.collection('Slides').updateOne(
            { fileId: new mongoose.Types.ObjectId(id) },
            { $set: { approved: false } }
        );

        if (!slide.matchedCount) {
            return res.status(404).json({ error: 'Slide not found' });
        }

        res.json({ message: 'Slide declined successfully' });
    } catch (err) {
        console.error('Failed to decline slide:', err);
        res.status(500).json({ error: 'Failed to decline slide' });
    }
});

app.put('/edit-department/:id', isAuthenticated, async (req, res) => {
    const { id } = req.params;
    const { department } = req.body;

    try {
        const result = await db.collection('Slides').updateOne(
            { fileId: new mongoose.Types.ObjectId(id) },
            { $set: { department: department } }
        );

        if (result.matchedCount === 0) {
            return res.status(404).json({ error: 'Slide not found' });
        }

        res.json({ message: 'Department updated successfully' });
    } catch (err) {
        console.error('Failed to update department:', err);
        res.status(500).json({ error: 'Failed to update department' });
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
