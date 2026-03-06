const fs = require('fs');
const path = require('path');
const { generateAllFavicons } = require('./favicon-generator');

async function main() {
  const imageSource = process.argv[2];
  if (!imageSource) {
    console.error('Usage: node utils/run-favicon-generator.js <image-url-or-data-uri>');
    process.exit(1);
  }

  const outputDir = path.join(__dirname, '..', 'tmp-favicons');
  fs.mkdirSync(outputDir, { recursive: true });

  const files = await generateAllFavicons(imageSource);
  const entries = Object.entries(files);

  if (!entries.length) {
    console.error('No favicon files generated.');
    process.exit(2);
  }

  for (const [filePath, content] of entries) {
    const fileName = path.basename(filePath);
    const outPath = path.join(outputDir, fileName);

    if (Buffer.isBuffer(content)) {
      fs.writeFileSync(outPath, content);
    } else {
      fs.writeFileSync(outPath, content, 'utf8');
    }
  }

  console.log(`Generated ${entries.length} files in ${outputDir}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(3);
});

