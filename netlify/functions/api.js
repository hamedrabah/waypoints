require('dotenv').config();
const express = require('express');
const axios = require('axios');
const path = require('path');
const multer = require('multer');
const fs = require('fs');
const FormData = require('form-data');
const serverless = require('serverless-http');

const app = express();

// Add CORS headers for all routes
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS, PUT, DELETE');
  res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept, Authorization');
  // Handle preflight requests
  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }
  next();
});

// Configure multer for file uploads
// For serverless functions, we need to use memory storage
const storage = multer.memoryStorage();
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

// Prefix all routes with /.netlify/functions/api
const router = express.Router();

// Google Maps Geocoding API endpoint
const GEOCODING_API_URL = 'https://maps.googleapis.com/maps/api/geocode/json';

// Skydio Cloud API endpoints
const SKYDIO_API_BASE_URL = process.env.SKYDIO_API_BASE_URL || 'https://api.skydio.com';

// Add a simple test endpoint to verify API is working
router.get('/test', (req, res) => {
  res.json({
    status: 'ok',
    message: 'API is working correctly',
    timestamp: new Date().toISOString()
  });
});

/**
 * Geocode an address to get coordinates
 */
router.post('/geocode', async (req, res) => {
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
router.post('/analyze-image', upload.single('image'), async (req, res) => {
  try {
    // City will always be San Francisco
    const city = 'San Francisco';
    
    if (!req.file) {
      return res.status(400).json({ error: 'Image file is required' });
    }
    
    // Convert buffer to base64
    const base64Image = req.file.buffer.toString('base64');
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
              text: `This image is from ${city}. Please analyze it and provide the top 3 most probable locations for the place shown, with their coordinates and a confidence score. Return ONLY a plain JSON object with a \"locations\" array containing 3 objects, each with these keys: lat (number), lng (number), location_description (string), confidence (integer between 0 and 100). The sum of the 3 confidence values must be exactly 100. Sort the locations by confidence in descending order. Do not include code blocks, backticks, or any other formatting.`
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
        'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`
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
      
      // Check if we have the expected locations array
      if (parsedResponse.locations && Array.isArray(parsedResponse.locations) && parsedResponse.locations.length > 0) {
        // Normalize confidence values to sum to 100
        let locs = parsedResponse.locations;
        // Only keep the top 3 if more are returned
        if (locs.length > 3) locs = locs.slice(0, 3);
        // Extract confidences
        let confidences = locs.map(l => typeof l.confidence === 'number' ? l.confidence : 0);
        let sum = confidences.reduce((a, b) => a + b, 0);
        if (sum !== 100) {
          // Scale to sum to 100
          confidences = confidences.map(c => c / sum * 100);
          // Round to integers
          confidences = confidences.map(Math.round);
          // Adjust the largest value to make the sum exactly 100
          let newSum = confidences.reduce((a, b) => a + b, 0);
          if (newSum !== 100) {
            let maxIdx = confidences.indexOf(Math.max(...confidences));
            confidences[maxIdx] += 100 - newSum;
          }
        }
        // Assign back to locations
        locs = locs.map((l, i) => ({ ...l, confidence: confidences[i] }));
        return res.json({
          locations: locs,
          image_filename: req.file.originalname
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
          image_filename: req.file.originalname
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
    
    return res.status(500).json({ 
      error: 'Failed to analyze image', 
      details: error.message 
    });
  }
});

/**
 * Create a waypoint at the specified coordinates in Skydio
 */
router.post('/waypoint', async (req, res) => {
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

/**
 * Endpoint to provide the Google Maps API key to the frontend
 */
router.get('/maps-api-key', (req, res) => {
  if (!process.env.GOOGLE_MAPS_API_KEY) {
    return res.status(500).json({ error: 'Google Maps API key is not configured' });
  }
  
  res.json({ key: process.env.GOOGLE_MAPS_API_KEY });
});

/**
 * Endpoint to fetch recent 911 calls from SF Gov data
 */
router.get('/911-calls', async (req, res) => {
  try {
    const { limit = 50 } = req.query;
    
    // Fetch recent 911 calls from SF Gov API
    const response = await axios.get('https://data.sfgov.org/resource/wg3w-h783.json', {
      params: {
        '$limit': limit,
        '$order': 'incident_datetime DESC'
      }
    });
    
    return res.json(response.data);
  } catch (error) {
    console.error('Error fetching 911 calls:', error);
    return res.status(500).json({ error: 'Failed to fetch 911 calls data', details: error.message });
  }
});

app.use('/.netlify/functions/api', router);

// Export the serverless function
module.exports.handler = serverless(app); 