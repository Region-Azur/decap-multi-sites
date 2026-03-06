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
 * Block SSRF: validate that a URL points to a public internet host.
 * Throws if the URL is private, loopback, link-local, or uses a non-http(s) protocol.
 */
function validatePublicUrl(rawUrl) {
  let parsed;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new Error(`Invalid URL: ${rawUrl}`);
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`Disallowed protocol "${parsed.protocol}" in favicon URL`);
  }

  const hostname = parsed.hostname.toLowerCase();

  // Block loopback
  if (hostname === 'localhost' || hostname === '::1') {
    throw new Error('Favicon URL must not point to localhost');
  }

  // Block IPv4 private / reserved ranges using a numeric comparison
  const ipv4Match = hostname.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (ipv4Match) {
    const [, a, b, c, d] = ipv4Match.map(Number);
    if (
      a === 10 ||                                         // 10.0.0.0/8
      (a === 172 && b >= 16 && b <= 31) ||                // 172.16.0.0/12
      (a === 192 && b === 168) ||                         // 192.168.0.0/16
      (a === 127) ||                                      // 127.0.0.0/8
      (a === 169 && b === 254) ||                         // 169.254.0.0/16  (link-local / cloud metadata)
      (a === 0) ||                                        // 0.0.0.0/8
      (a === 100 && b >= 64 && b <= 127) ||               // 100.64.0.0/10  (shared address space)
      (a === 192 && b === 0 && c === 2) ||                // 192.0.2.0/24   (TEST-NET)
      (a === 198 && b >= 18 && b <= 19) ||                // 198.18.0.0/15  (benchmarking)
      (a === 240)                                         // 240.0.0.0/4    (reserved)
    ) {
      throw new Error(`Favicon URL hostname "${hostname}" is in a private/reserved IP range`);
    }
  }

  // Block IPv6 private ranges
  if (
    hostname.startsWith('[::') ||
    hostname.startsWith('[fc') ||
    hostname.startsWith('[fd') ||
    hostname.startsWith('[fe80')
  ) {
    throw new Error(`Favicon URL hostname "${hostname}" is a private IPv6 address`);
  }
}

/**
 * Download image from URL (only after SSRF validation)
 * @param {string} url - Image URL
 */
async function downloadImage(url) {
  validatePublicUrl(url);
  return new Promise((resolve, reject) => {
    const protocol = url.startsWith('https') ? https : http;

    protocol.get(url, { timeout: 10000 }, (response) => {
      if (response.statusCode !== 200) {
        reject(new Error(`Failed to download image: HTTP ${response.statusCode}`));
        return;
      }

      const MAX_SIZE = 10 * 1024 * 1024; // 10 MB limit
      let totalSize = 0;
      const chunks = [];

      response.on('data', (chunk) => {
        totalSize += chunk.length;
        if (totalSize > MAX_SIZE) {
          response.destroy();
          reject(new Error('Image exceeds 10 MB size limit'));
          return;
        }
        chunks.push(chunk);
      });
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
 * Generate ICO file (multi-resolution: 16x16 + 32x32)
 * @param {Buffer} sourceBuffer - Source image buffer
 * @returns {Promise<Buffer>} ICO buffer
 */
async function generateIco(sourceBuffer) {
  const png16 = await generatePng(sourceBuffer, 16, 16);
  const png32 = await generatePng(sourceBuffer, 32, 32);
  // pngToIco expects an array of PNG buffers and produces a real .ico file
  return await pngToIco([png16, png32]);
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
