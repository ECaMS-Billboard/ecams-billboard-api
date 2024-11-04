const express = require('express'); // Import Express
const cors = require('cors'); // Import CORS
const mongoose = require('mongoose');
const path = require('path'); // Import file paths

// Create an Express application
const app = express();
const port = process.env.PORT || 3000; // Set the port
app.use(cors()); // Allow CORS

// Use static files from the 'static' folder
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
