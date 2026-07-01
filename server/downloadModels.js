// ==================== MODEL DOWNLOAD SCRIPT ====================
// This script downloads the face-api.js models for local use
// Run this once before starting the server
// Command: npm run download-models

const fs = require('fs');
const path = require('path');
const https = require('https');

const MODELS_DIR = path.join(__dirname, '../models');
const MODEL_FILES = [
  {
    name: 'ssd_mobilenetv1_model-weights_manifest.json',
    url: 'https://raw.githubusercontent.com/justadudewhohacks/face-api.js/master/weights/ssd_mobilenetv1_model-weights_manifest.json'
  },
  {
    name: 'ssd_mobilenetv1_model-shard1',
    url: 'https://raw.githubusercontent.com/justadudewhohacks/face-api.js/master/weights/ssd_mobilenetv1_model-shard1'
  },
  {
    name: 'ssd_mobilenetv1_model-shard2',
    url: 'https://raw.githubusercontent.com/justadudewhohacks/face-api.js/master/weights/ssd_mobilenetv1_model-shard2'
  },
  {
    name: 'face_landmark_68_model-weights_manifest.json',
    url: 'https://raw.githubusercontent.com/justadudewhohacks/face-api.js/master/weights/face_landmark_68_model-weights_manifest.json'
  },
  {
    name: 'face_landmark_68_model-shard1',
    url: 'https://raw.githubusercontent.com/justadudewhohacks/face-api.js/master/weights/face_landmark_68_model-shard1'
  },
  {
    name: 'face_recognition_model-weights_manifest.json',
    url: 'https://raw.githubusercontent.com/justadudewhohacks/face-api.js/master/weights/face_recognition_model-weights_manifest.json'
  },
  {
    name: 'face_recognition_model-shard1',
    url: 'https://raw.githubusercontent.com/justadudewhohacks/face-api.js/master/weights/face_recognition_model-shard1'
  },
  {
    name: 'face_recognition_model-shard2',
    url: 'https://raw.githubusercontent.com/justadudewhohacks/face-api.js/master/weights/face_recognition_model-shard2'
  }
];

/**
 * Download a file from URL to local path
 */
function downloadFile(url, filePath) {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(filePath);
    https.get(url, (response) => {
      if (response.statusCode !== 200) {
        reject(new Error(`Failed to download ${url}: ${response.statusCode}`));
        return;
      }
      response.pipe(file);
      file.on('finish', () => {
        file.close();
        resolve();
      });
      file.on('error', reject);
    }).on('error', reject);
  });
}

/**
 * Download all face-api.js models
 */
async function downloadModels() {
  console.log('=========================================');
  console.log('🔄 Downloading face-api.js models...');
  console.log('=========================================');
  
  // Create models directory if it doesn't exist
  if (!fs.existsSync(MODELS_DIR)) {
    fs.mkdirSync(MODELS_DIR, { recursive: true });
    console.log(`📁 Created models directory: ${MODELS_DIR}`);
  }
  
  let successCount = 0;
  let failCount = 0;
  
  for (const model of MODEL_FILES) {
    const filePath = path.join(MODELS_DIR, model.name);
    
    try {
      // Check if file already exists
      if (fs.existsSync(filePath)) {
        console.log(`✅ ${model.name} already exists, skipping...`);
        successCount++;
        continue;
      }
      
      console.log(`⬇️  Downloading ${model.name}...`);
      await downloadFile(model.url, filePath);
      console.log(`✅ Downloaded ${model.name}`);
      successCount++;
    } catch (error) {
      console.error(`❌ Error downloading ${model.name}:`, error.message);
      failCount++;
    }
  }
  
  console.log('=========================================');
  console.log(`✅ Successfully downloaded: ${successCount} files`);
  if (failCount > 0) {
    console.log(`❌ Failed to download: ${failCount} files`);
    console.log('💡 Please try running the script again');
  } else {
    console.log('✅ All models downloaded successfully!');
  }
  console.log(`📁 Models saved to: ${MODELS_DIR}`);
  console.log('=========================================');
  console.log('🚀 You can now start the server: npm start');
  console.log('=========================================');
}

// Run the download if this script is executed directly
if (require.main === module) {
  downloadModels().catch(console.error);
}

module.exports = { downloadModels };
