require('dotenv').config();
const express = require('express');
const axios = require('axios');
const path = require('path');
const multer = require('multer');
const fs = require('fs');
const FormData = require('form-data');

const app = express();
const PORT = process.env.PORT || 3000;

// Configure multer for file uploads
const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    const uploadDir = path.join(__dirname, '../uploads');
    if (!fs.existsSync(uploadDir)) {
      fs.mkdirSync(uploadDir, { recursive: true });
    }
    cb(null, uploadDir);
  },
  filename: function (req, file, cb) {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
    cb(null, file.fieldname + '-' + uniqueSuffix + path.extname(file.originalname));
  }
});
const upload = multer({ 
  storage: storage,
  limits: { fileSize: 5 * 1024 * 1024 }, // 5MB limit
  fileFilter: function (req, file, cb) {
    // Accept images only
    if (!file.originalname.match(/\.(jpg|jpeg|png|gif)$/)) {
      return cb(new Error('Only image files are allowed!'), false);
    }
    cb(null, true);
  }
});

// OpenAI API configuration
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const OPENAI_API_URL = 'https://api.openai.com/v1/chat/completions';

// Middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, '../public')));

// Google Maps Geocoding API endpoint
const GEOCODING_API_URL = 'https://maps.googleapis.com/maps/api/geocode/json';

// Skydio Cloud API endpoints
const SKYDIO_API_BASE_URL = process.env.SKYDIO_API_BASE_URL || 'https://api.skydio.com';

/**
 * Geocode an address to get coordinates
 */
app.post('/api/geocode', async (req, res) => {
  try {
    const { address } = req.body;
    
    if (!address) {
      return res.status(400).json({ error: 'Address is required' });
    }
    
    if (!process.env.GOOGLE_MAPS_API_KEY) {
      return res.status(500).json({ error: 'Google Maps API key is not configured' });
    }
    
    const response = await axios.get(GEOCODING_API_URL, {
      params: {
        address,
        key: process.env.GOOGLE_MAPS_API_KEY
      }
    });
    
    if (response.data.status !== 'OK') {
      return res.status(400).json({ error: 'Failed to geocode address', details: response.data.status });
    }
    
    const location = response.data.results[0].geometry.location;
    
    return res.json({
      address: response.data.results[0].formatted_address,
      lat: location.lat,
      lng: location.lng
    });
  } catch (error) {
    console.error('Geocoding error:', error);
    return res.status(500).json({ error: 'Failed to geocode address', details: error.message });
  }
});

/**
 * Analyze image using OpenAI's 4o model to identify location
 */
app.post('/api/analyze-image', upload.single('image'), async (req, res) => {
  try {
    const { city } = req.body;
    
    if (!city) {
      return res.status(400).json({ error: 'City name is required' });
    }
    
    if (!req.file) {
      return res.status(400).json({ error: 'Image file is required' });
    }
    
    // Convert image to base64
    const imageBuffer = fs.readFileSync(req.file.path);
    const base64Image = imageBuffer.toString('base64');
    const dataURI = `data:${req.file.mimetype};base64,${base64Image}`;
    
    // Create the OpenAI API request
    const openAIRequest = {
      model: "gpt-4o",
      messages: [
        {
          role: "system",
          content: "You are a location identification expert who specializes in identifying places from images. Your task is to analyze the image and determine the most likely locations shown in the image. Be as specific as possible. IMPORTANT: Return ONLY raw JSON without any markdown formatting, explanation or code blocks."
        },
        {
          role: "user",
          content: [
            {
              type: "text",
              text: `This image is from ${city}. Please analyze it and provide the top 5 most probable locations for the place shown, with their coordinates and a confidence score. Return ONLY a plain JSON object with a "locations" array containing 5 objects, each with these keys: lat (number), lng (number), location_description (string), confidence (number between 0-1). Sort the locations by confidence in descending order. Do not include code blocks, backticks, or any other formatting.`
            },
            {
              type: "image_url",
              image_url: {
                url: dataURI
              }
            }
          ]
        }
      ]
    };
    
    // Call OpenAI API
    const openAIResponse = await axios.post(OPENAI_API_URL, openAIRequest, {
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${OPENAI_API_KEY}`
      }
    });
    
    // Parse the response to extract coordinates
    const responseText = openAIResponse.data.choices[0].message.content;
    
    try {
      // Try to parse as JSON directly first
      let parsedResponse;
      try {
        parsedResponse = JSON.parse(responseText);
      } catch (directJsonError) {
        // If direct parsing fails, look for JSON in markdown code blocks
        const jsonRegex = /```(?:json)?\s*({[\s\S]*?})\s*```/;
        const match = responseText.match(jsonRegex);
        
        if (match && match[1]) {
          try {
            parsedResponse = JSON.parse(match[1]);
          } catch (markdownJsonError) {
            console.error('Error parsing JSON from markdown:', markdownJsonError);
            throw new Error('Could not parse JSON from markdown response');
          }
        } else {
          throw new Error('No valid JSON found in the response');
        }
      }
      
      // Clean up the temporary file
      fs.unlinkSync(req.file.path);
      
      // Check if we have the expected locations array
      if (parsedResponse.locations && Array.isArray(parsedResponse.locations) && parsedResponse.locations.length > 0) {
        // Return the full array of locations
        return res.json({
          locations: parsedResponse.locations,
          image_filename: req.file.filename
        });
      } else if (parsedResponse.lat && parsedResponse.lng) {
        // Handle the case where we just got a single location directly
        return res.json({
          locations: [{
            lat: parsedResponse.lat,
            lng: parsedResponse.lng,
            location_description: parsedResponse.location_description || `Location in ${city}`,
            confidence: parsedResponse.confidence || 0.7
          }],
          image_filename: req.file.filename
        });
      } else {
        throw new Error('No valid location data found in the response');
      }
    } catch (jsonError) {
      console.error('Error parsing OpenAI response as JSON:', jsonError);
      
      // If JSON parsing fails, try to extract coordinates using regex
      const latRegex = /latitude[:\s]+(-?\d+\.?\d*)/i;
      const lngRegex = /longitude[:\s]+(-?\d+\.?\d*)/i;
      
      const latMatch = responseText.match(latRegex);
      const lngMatch = responseText.match(lngRegex);
      
      if (latMatch && lngMatch) {
        // Clean up the temporary file
        fs.unlinkSync(req.file.path);
        
        return res.json({
          lat: parseFloat(latMatch[1]),
          lng: parseFloat(lngMatch[1]),
          location_description: `Location in ${city} based on image analysis`,
          confidence: 0.7 // Default moderate confidence
        });
      } else {
        throw new Error('Could not extract coordinates from OpenAI response');
      }
    }
    
  } catch (error) {
    console.error('Image analysis error:', error);
    
    // Clean up the temporary file if it exists
    if (req.file && req.file.path) {
      try {
        fs.unlinkSync(req.file.path);
      } catch (unlinkError) {
        console.error('Error deleting temporary file:', unlinkError);
      }
    }
    
    return res.status(500).json({ 
      error: 'Failed to analyze image', 
      details: error.message 
    });
  }
});

/**
 * Create a waypoint at the specified coordinates in Skydio
 */
app.post('/api/waypoint', async (req, res) => {
  try {
    const { lat, lng, name, address } = req.body;
    
    if (!lat || !lng) {
      return res.status(400).json({ error: 'Latitude and longitude are required' });
    }
    
    if (!process.env.SKYDIO_API_KEY || !process.env.SKYDIO_API_SECRET) {
      return res.status(500).json({ 
        error: 'Skydio API credentials are not configured',
        simulation: true,
        message: 'Running in simulation mode. Would create a waypoint at the specified coordinates.'
      });
    }
    
    // This is a simulation as we don't have full Skydio API credentials and documentation
    // In a real implementation, you would authenticate and call their API
    /* 
    const response = await axios.post(`${SKYDIO_API_BASE_URL}/waypoints`, {
      lat,
      lng,
      name: name || `Waypoint at ${address || 'specified coordinates'}`,
      altitude: 50, // default altitude in meters
    }, {
      headers: {
        'Authorization': `Bearer ${process.env.SKYDIO_API_KEY}`,
        'Content-Type': 'application/json'
      }
    });
    
    return res.json(response.data);
    */
    
    // Simulate a successful response
    return res.json({
      success: true,
      simulation: true,
      waypoint: {
        id: 'waypoint-' + Date.now(),
        lat,
        lng,
        name: name || `Waypoint at ${address || 'specified coordinates'}`,
        altitude: 50,
        createdAt: new Date().toISOString()
      },
      message: 'Waypoint created successfully (simulation)'
    });
  } catch (error) {
    console.error('Waypoint creation error:', error);
    return res.status(500).json({ error: 'Failed to create waypoint', details: error.message });
  }
});

// Start the server
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
}); 