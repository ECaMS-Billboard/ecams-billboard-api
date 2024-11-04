// Import the express module
const express = require('express');
const path = require('path');

// Create an instance of an Express application
const app = express();
const PORT = 3000;

// Serve static files from the "public" directory
app.use(express.static(path.join(__dirname, 'public')));

// Define the /prof-list route to return a simple JSON response
app.get('/prof-list', (req, res) => {
  res.json({ message: 'test' });
});

// Start the server and listen on the specified port
app.listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT}`);
});
