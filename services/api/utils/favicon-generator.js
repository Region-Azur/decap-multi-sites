const sharp = require('sharp');
const https = require('https');
const http = require('http');
const pngToIco = require('png-to-ico');

/**
 * Favicon Generator for Chirpy Theme
 * Generates all required favicon files from a single image
 */

// Favicon sizes required by Chirpy
const FAVICON_SIZES = {
  'favicon-16x16.png': { width: 16, height: 16 },
  'favicon-32x32.png': { width: 32, height: 32 },
  'apple-touch-icon.png': { width: 180, height: 180 },
  'android-chrome-192x192.png': { width: 192, height: 192 },
  'mstile-150x150.png': { width: 150, height: 150 },
  'web-app-manifest-192x192.png': { width: 192, height: 192 },
  'web-app-manifest-512x512.png': { width: 512, height: 512 }
};

/**
 * Download image from URL
 * @param {string} url - Image URL

 */
async function downloadImage(url) {
  return new Promise((resolve, reject) => {
    const protocol = url.startsWith('https') ? https : http;
    
    protocol.get(url, (response) => {
      if (response.statusCode !== 200) {
        reject(new Error(`Failed to download image: HTTP ${response.statusCode}`));
        return;
      }

      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => resolve(Buffer.concat(chunks)));
      response.on('error', reject);
    }).on('error', reject);
  });
}

/**
 * Convert data URI to buffer
 * @param {string} dataUri - Data URI string (e.g., data:image/png;base64,...)
 * @returns {Buffer} Image buffer
 */
function dataUriToBuffer(dataUri) {
  const base64Data = dataUri.split(',')[1];
  if (!base64Data) {
    throw new Error('Invalid data URI format');
  }
  return Buffer.from(base64Data, 'base64');
}

/**
 * Get image buffer from various sources
 * @param {string|Buffer} imageSource - URL, data URI, or Buffer
 * @returns {Promise<Buffer>} Image buffer
 */
async function getImageBuffer(imageSource) {
  if (Buffer.isBuffer(imageSource)) {
    return imageSource;
  }

  if (typeof imageSource === 'string') {
    if (imageSource.startsWith('data:')) {
      return dataUriToBuffer(imageSource);
    }
    
    // Check if it's a URL
    if (imageSource.startsWith('http://') || imageSource.startsWith('https://')) {
      return await downloadImage(imageSource);
    }
    
    // Assume it's base64
    return Buffer.from(imageSource, 'base64');
  }

  throw new Error('Invalid image source: must be URL, data URI, or Buffer');
}

/**
 * Generate a single favicon PNG file
 * @param {Buffer} sourceBuffer - Source image buffer
 * @param {number} width - Target width
 * @param {number} height - Target height
 * @returns {Promise<Buffer>} PNG buffer
 */
async function generatePng(sourceBuffer, width, height) {
  return await sharp(sourceBuffer)
    .resize(width, height, {
      fit: 'cover',
      position: 'center'
    })
    .png()
    .toBuffer();
}

/**
 * Generate ICO file (multi-resolution)
 * @param {Buffer} sourceBuffer - Source image buffer
 * @returns {Promise<Buffer>} ICO buffer
 */
async function generateIco(sourceBuffer) {
  const png16 = await generatePng(sourceBuffer, 16, 16);
  const png32 = await generatePng(sourceBuffer, 32, 32);
  return png32;
}

/**
 * Generate SVG favicon (pinned tab icon for Safari)
 * @param {Buffer} sourceBuffer - Source image buffer
 * @returns {Promise<string>} SVG string
 */
async function generateSvg(sourceBuffer) {
  const png32 = await generatePng(sourceBuffer, 32, 32);
  const base64Png = png32.toString('base64');
  return `<?xml version="1.0" encoding="UTF-8"?>\n<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 32 32">\n  <image width="32" height="32" href="data:image/png;base64,${base64Png}"/>\n</svg>`;
}

/**
 * Generate browserconfig.xml for Windows tiles
 * @returns {string} XML string
 */
function generateBrowserConfig() {
  return `<?xml version="1.0" encoding="utf-8"?>
<browserconfig>
  <msapplication>
    <tile>
      <square150x150logo src="/assets/img/favicons/mstile-150x150.png"/>
      <TileColor>#da532c</TileColor>
    </tile>
  </msapplication>
</browserconfig>`;
}

/**
 * Generate all favicon files for Chirpy theme
 * @param {string|Buffer} imageSource - Image URL, data URI, or Buffer
 * @returns {Promise<Object>} Object with filename as key and buffer/string as value
 */
async function generateAllFavicons(imageSource) {
  console.log('DEBUG: Starting favicon generation...');
  
  if (!imageSource) {
    console.log('DEBUG: No image source provided for favicon generation');
    return {};
  }

  try {
    // Get the source image buffer
    const sourceBuffer = await getImageBuffer(imageSource);
    console.log(`DEBUG: Image loaded, size: ${sourceBuffer.length} bytes`);

    const favicons = {};

    // Generate all PNG sizes
    for (const [filename, size] of Object.entries(FAVICON_SIZES)) {
      console.log(`DEBUG: Generating ${filename} (${size.width}x${size.height})`);
      favicons[`assets/img/favicons/${filename}`] = await generatePng(
        sourceBuffer,
        size.width,
        size.height
      );
    }

    // Generate ICO file
    console.log('DEBUG: Generating favicon.ico');
    favicons['assets/img/favicons/favicon.ico'] = await generateIco(sourceBuffer);

    // Generate SVG (Safari pinned tab)
    console.log('DEBUG: Generating safari-pinned-tab.svg');
    favicons['assets/img/favicons/safari-pinned-tab.svg'] = await generateSvg(sourceBuffer);

    // Generate browserconfig.xml
    console.log('DEBUG: Generating browserconfig.xml');
    favicons['assets/img/favicons/browserconfig.xml'] = generateBrowserConfig();

    return favicons;

  } catch (error) {
    console.error(`DEBUG: Failed to generate favicons: ${error.message}`);
    console.error(error.stack);
    return {};
  }
}

module.exports = {
  generateAllFavicons,
  getImageBuffer,
  generatePng
};
