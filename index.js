const express = require('express'); // Import Express
const cors = require('cors'); // Import CORS
const path = require('path'); // Import file paths

// Create an Express application
const app = express();
const port = process.env.PORT || 3000; // Set the port

// Allow requests from all origins
app.use(cors());

// Use static files from the 'static' folder
app.use(express.static(path.join(__dirname, 'static')));


// Define the /prof-list route to return a simple JSON response
app.get('/prof-list', (req, res) => {
    res.json({ message: 'test' });
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
