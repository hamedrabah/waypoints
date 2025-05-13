# Waypoints

Access real time 911 data, address and image reverse lookup, and set waypoints for drones 

A web application that allows users to enter a street address, which is then geocoded to coordinates and set as a waypoint for a Skydio drone.

## Features

- Geocode street addresses to geographic coordinates
- Set waypoints on Skydio drones using the Skydio Cloud API
- Visual map display of the waypoint location
- Responsive design for desktop and mobile use
- Simulated waypoint creation when API credentials are not configured
- Access to real time 911 data
- Image reverse lookup for location identification

## Prerequisites

- Node.js (v14+)
- npm or yarn
- Google Maps API key for geocoding
- Skydio Cloud API credentials (for actual waypoint creation)

## Installation

1. Clone the repository:
   ```
   git clone https://github.com/hamedrabah/waypoints.git
   cd waypoints
   ```

2. Install dependencies:
   ```
   npm install
   ```

3. Create a `.env` file in the root directory with your API keys:
   ```
   # Copy from .env-example
   cp .env-example .env
   ```
   Then edit the `.env` file and add your API keys:
   ```
   # Server configuration
   PORT=3000

   # API Keys
   OPENAI_API_KEY=your_openai_api_key_here
   GOOGLE_MAPS_API_KEY=your_google_maps_api_key_here

   # Skydio API configuration 
   SKYDIO_API_BASE_URL=https://api.skydio.com
   SKYDIO_API_KEY=your_skydio_api_key_here
   SKYDIO_API_SECRET=your_skydio_api_secret_here
   ```

4. Update the Google Maps API key in `public/index.html`:
   ```html
   <script async defer
     src="https://maps.googleapis.com/maps/api/js?key=YOUR_GOOGLE_MAPS_API_KEY&callback=initMap">
   </script>
   ```

## Usage

1. Start the development server:
   ```
   npm run dev
   ```

2. Open your browser and navigate to `http://localhost:3000`

3. Enter a street address in the form and click "Create Waypoint"

4. The application will geocode the address, display it on the map, and attempt to create a waypoint through the Skydio API

## Simulation Mode

If Skydio API credentials are not configured, the application will run in simulation mode:

- Address geocoding will still work if Google Maps API key is configured
- Waypoint creation will show a simulation message
- The map will display the waypoint location

## Production Deployment

To start the server in production mode:

```
npm start
```

## API Key Security

This application requires several API keys to function properly:

1. **OpenAI API Key** - For image analysis and location identification
2. **Google Maps API Key** - For geocoding addresses and map display
3. **Skydio API Credentials** - For drone waypoint creation

To keep these keys secure:

- Never commit API keys to your repository
- Always use environment variables to store sensitive information
- Add `.env` to your `.gitignore` file (already done in this repo)
- Create a `.env.example` file with placeholders to show required variables
- For production, use a secure environment variable management system

## Notes

- This application requires proper Skydio Cloud API credentials for actual waypoint creation
- For development and testing, you may need to obtain a Skydio developer account
- Check the Skydio developer documentation for more information on their Cloud API

## License

MIT
