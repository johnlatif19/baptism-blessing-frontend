// ==================== FACE DETECTION MODULE ====================
// This module handles face detection and embedding generation using face-api.js
// All processing runs locally within Node.js

const faceapi = require('face-api.js');
const canvas = require('canvas');
const path = require('path');

// Configure face-api.js to use canvas
const { Canvas, Image, ImageData } = canvas;
faceapi.env.monkeyPatch({ Canvas, Image, ImageData });

// Path to models - will be downloaded automatically
const MODEL_PATH = path.join(__dirname, '../models');

// Cache for loaded models
let modelsLoaded = false;

/**
 * Load face-api.js models
 * Models are downloaded from the face-api.js repository
 */
async function loadModels() {
  if (modelsLoaded) return;
  
  try {
    console.log('🔄 Loading face detection models...');
    
    // Load models from the specified path
    // The models will be downloaded automatically by face-api.js
    await faceapi.nets.ssdMobilenetv1.loadFromDisk(MODEL_PATH);
    await faceapi.nets.faceLandmark68Net.loadFromDisk(MODEL_PATH);
    await faceapi.nets.faceRecognitionNet.loadFromDisk(MODEL_PATH);
    
    modelsLoaded = true;
    console.log('✅ Face detection models loaded successfully');
  } catch (error) {
    console.error('❌ Error loading face detection models:', error);
    throw new Error('Failed to load face detection models');
  }
}

/**
 * Detect faces and generate embeddings from an image buffer
 * @param {Buffer} imageBuffer - Image data as buffer
 * @returns {Promise<Array<{embedding: number[], detection: object}>>}
 */
async function detectFacesAndEmbeddings(imageBuffer) {
  try {
    await loadModels();
    
    // Load image from buffer
    const img = await canvas.loadImage(imageBuffer);
    
    // Detect faces with SSD Mobilenet V1
    const detections = await faceapi.detectAllFaces(img, new faceapi.SsdMobilenetv1Options({
      minConfidence: 0.5
    })).withFaceLandmarks().withFaceDescriptors();
    
    if (!detections || detections.length === 0) {
      return [];
    }
    
    // Extract embeddings (descriptors) from detections
    const results = detections.map(detection => ({
      embedding: Array.from(detection.descriptor),
      detection: {
        x: detection.detection.box.x,
        y: detection.detection.box.y,
        width: detection.detection.box.width,
        height: detection.detection.box.height,
        confidence: detection.detection.score
      }
    }));
    
    return results;
  } catch (error) {
    console.error('Error detecting faces:', error);
    throw new Error(`Face detection failed: ${error.message}`);
  }
}

/**
 * Calculate Euclidean distance between two embeddings
 * @param {number[]} embedding1 - First embedding array
 * @param {number[]} embedding2 - Second embedding array
 * @returns {number} Euclidean distance
 */
function calculateDistance(embedding1, embedding2) {
  if (embedding1.length !== embedding2.length) {
    throw new Error('Embeddings must have the same length');
  }
  
  let sum = 0;
  for (let i = 0; i < embedding1.length; i++) {
    const diff = embedding1[i] - embedding2[i];
    sum += diff * diff;
  }
  
  return Math.sqrt(sum);
}

/**
 * Convert distance to similarity score (0-1)
 * Higher similarity = closer to 1
 * @param {number} distance - Euclidean distance
 * @param {number} threshold - Distance threshold (lower = stricter)
 * @returns {number} Similarity score between 0 and 1
 */
function distanceToSimilarity(distance, threshold = 0.6) {
  // Convert distance to similarity using exponential decay
  // At distance = 0, similarity = 1
  // At distance = threshold, similarity = 0.5
  // At distance > threshold, similarity approaches 0
  const similarity = Math.exp(-distance / threshold);
  return Math.max(0, Math.min(1, similarity));
}

/**
 * Compare a query embedding against a list of stored embeddings
 * @param {number[]} queryEmbedding - The embedding to compare
 * @param {Array<{embedding: number[], id: string, metadata: object}>} storedEmbeddings - List of stored embeddings
 * @param {number} similarityThreshold - Minimum similarity to consider a match (0-1)
 * @returns {Array<{similarity: number, id: string, metadata: object}>} Matches sorted by similarity
 */
function compareEmbeddings(queryEmbedding, storedEmbeddings, similarityThreshold = 0.5) {
  const results = [];
  
  for (const stored of storedEmbeddings) {
    try {
      const distance = calculateDistance(queryEmbedding, stored.embedding);
      const similarity = distanceToSimilarity(distance);
      
      if (similarity >= similarityThreshold) {
        results.push({
          similarity: Math.round(similarity * 100) / 100, // Round to 2 decimals
          distance: Math.round(distance * 1000) / 1000,
          imageId: stored.imageId,
          metadata: stored.metadata || {}
        });
      }
    } catch (error) {
      console.error('Error comparing embedding:', error);
      // Skip this embedding on error
    }
  }
  
  // Sort by similarity (descending)
  results.sort((a, b) => b.similarity - a.similarity);
  
  return results;
}

/**
 * Extract face data from image buffer and generate embeddings
 * @param {Buffer} imageBuffer - Image data as buffer
 * @param {object} imageMetadata - Additional metadata to store with the face
 * @returns {Promise<Array<{embedding: number[], metadata: object}>>}
 */
async function extractFaceEmbeddings(imageBuffer, imageMetadata = {}) {
  const faceData = await detectFacesAndEmbeddings(imageBuffer);
  
  return faceData.map((face, index) => ({
    embedding: face.embedding,
    metadata: {
      ...imageMetadata,
      faceIndex: index,
      detection: face.detection
    }
  }));
}

module.exports = {
  loadModels,
  detectFacesAndEmbeddings,
  calculateDistance,
  distanceToSimilarity,
  compareEmbeddings,
  extractFaceEmbeddings
};
