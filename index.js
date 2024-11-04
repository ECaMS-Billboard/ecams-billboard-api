const express = require('express');
const cors = require('cors');
const mongoose = require('mongoose');
const path = require('path');

// Load environment variables from a .env file if available
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 5000;

console.log("App is starting...");

// MongoURI - Ensure to use an environment variable for better security in production
const MONGO_URI = "mongodb+srv://ecamsbb:0JqIEtTsol8lXab1@ecamsdb.kk917.mongodb.net/?retryWrites=true&w=majority&appName=EcamsBB";
console.log("MONGO_URI:", MONGO_URI);

// Enable CORS - Adjust 'origin' as needed for your deployment (for security)
app.use(cors());
app.use(express.json());

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

// Serve index.html as the static file
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

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

// Start the server
app.listen(PORT, () => {
  console.log(`Server running at ${process.env.BASE_URL || `http://localhost:${PORT}`}`);
});
