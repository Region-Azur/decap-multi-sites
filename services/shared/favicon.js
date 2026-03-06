/**
 * Global Favicon Configuration
 * 
 * This module provides favicon HTML link tags for all portal pages.
 * 
 * To change the favicon:
 * 1. Place your favicon files in `static-assets/` directory (project root)
 * 2. Rebuild Docker containers: docker-compose build portal oauth2_proxy
 * 3. Restart services: docker-compose up -d
 * 
 * Required files in static-assets/:
 * - favicon.ico (main favicon)
 * - favicon-16x16.png (optional)
 * - favicon-32x32.png (optional)
 * - apple-touch-icon.png (optional, for iOS)
 * 
 * Docker automatically copies these files during build to:
 * - Portal: /app/public/ (served at /)
 * - oauth2-proxy: /static/ (served at /)
 */

// Emoji-based SVG fallback (if static files don't load)
const FAVICON_EMOJI = '🔐';
const FAVICON_SVG_DATA_URI = `data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><text y='.9em' font-size='90'>${FAVICON_EMOJI}</text></svg>`;

/**
 * Get the favicon HTML link tags
 * References static files that Docker copies from static-assets/
 * @returns {string} HTML link tags for favicon
 */
function getFaviconHTML() {
  return `<link rel="icon" type="image/x-icon" href="/favicon.ico" />
    <link rel="icon" type="image/svg+xml" href="${FAVICON_SVG_DATA_URI}" />
    <link rel="icon" type="image/png" sizes="32x32" href="/favicon-32x32.png" />
    <link rel="icon" type="image/png" sizes="16x16" href="/favicon-16x16.png" />
    <link rel="apple-touch-icon" sizes="180x180" href="/apple-touch-icon.png" />`;
}

module.exports = {
  getFaviconHTML
};



