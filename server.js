require('dotenv').config();
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const compression = require('compression');
const rateLimit = require('express-rate-limit');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const multer = require('multer');
const { body, validationResult } = require('express-validator');
const path = require('path');
const cloudinary = require('cloudinary').v2;
const admin = require('firebase-admin');
const { v4: uuidv4 } = require('uuid');

// ==================== FACE RECOGNITION SETUP ====================
const faceapi = require('@vladmandic/face-api');
const canvas = require('canvas');

// Configure face-api to use canvas
const { Canvas, Image, ImageData } = canvas;
faceapi.env.monkeyPatch({ Canvas, Image, ImageData });

let faceDetectionModelLoaded = false;

// Load face detection models on startup
async function loadFaceModels() {
    try {
        // Models will be loaded from node_modules/@vladmandic/face-api/model
        await faceapi.nets.ssdMobilenetv1.loadFromDisk('./node_modules/@vladmandic/face-api/model');
        await faceapi.nets.faceLandmark68Net.loadFromDisk('./node_modules/@vladmandic/face-api/model');
        await faceapi.nets.faceRecognitionNet.loadFromDisk('./node_modules/@vladmandic/face-api/model');
        faceDetectionModelLoaded = true;
        console.log('✅ Face detection models loaded successfully');
    } catch (error) {
        console.error('❌ Failed to load face detection models:', error.message);
        console.log('⚠️ Face recognition features will be disabled');
        // Continue without face detection - features will be disabled
    }
}

// Call this after server starts
loadFaceModels();

// ==================== INITIALIZATION ====================

// Validate required environment variables
const requiredEnvVars = [
  'JWT_SECRET',
  'CLOUDINARY_CLOUD_NAME',
  'CLOUDINARY_API_KEY',
  'CLOUDINARY_API_SECRET',
  'FIREBASE_CONFIG',
  'ADMIN_USERNAME',
  'ADMIN_PASSWORD'
];

const missingEnvVars = requiredEnvVars.filter(varName => !process.env[varName]);
if (missingEnvVars.length > 0) {
  console.error(`❌ Missing required environment variables: ${missingEnvVars.join(', ')}`);
  console.error('Please check your .env file');
  process.exit(1);
}

// Initialize Firebase Admin
let firebaseConfig;
try {
  firebaseConfig = JSON.parse(process.env.FIREBASE_CONFIG);
} catch (error) {
  console.error('❌ Invalid FIREBASE_CONFIG JSON format:', error.message);
  process.exit(1);
}

admin.initializeApp({
  credential: admin.credential.cert(firebaseConfig)
});

const db = admin.firestore();

// Initialize Cloudinary
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET
});

// ==================== EXPRESS APP ====================

const app = express();
const PORT = process.env.PORT || 3000;

// ==================== MIDDLEWARE ====================

// Security headers
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "'unsafe-inline'", "https://api.qrserver.com", "https://cdn.jsdelivr.net"],
      styleSrc: ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
      fontSrc: ["'self'", "https://fonts.gstatic.com"],
      imgSrc: ["'self'", "data:", "https://res.cloudinary.com", "https://api.qrserver.com"],
      frameSrc: ["'self'", "https://www.google.com", "https://www.youtube.com"],
      connectSrc: ["'self'"],
    },
  },
  crossOriginEmbedderPolicy: false
}));

// CORS
app.use(cors({
  origin: process.env.NODE_ENV === 'production' 
    ? ['https://baptism-blessing.vercel.app']
    : ['http://localhost:3000', 'http://localhost:5500', 'http://127.0.0.1:5500'],
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));

// Compression
app.use(compression());

// JSON and URL encoded - زودنا لـ 500MB
app.use(express.json({ limit: '500mb' }));
app.use(express.urlencoded({ extended: true, limit: '500mb' }));

// Static files
app.use(express.static(path.join(__dirname, 'public'), {
  maxAge: '1y',
  etag: true
}));

// ==================== RATE LIMITING ====================

const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 1000,
  message: 'Too many requests from this IP, please try again later.',
  standardHeaders: true,
  legacyHeaders: false
});
app.use('/api/', limiter);

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  message: 'Too many authentication attempts, please try again later.',
  standardHeaders: true,
  legacyHeaders: false
});
app.use('/api/login', authLimiter);

// ==================== MULTER CONFIGURATION ====================

const storage = multer.memoryStorage();
const upload = multer({
  storage: storage,
  limits: {
    fileSize: 500 * 1024 * 1024 // 500MB for videos
  },
  fileFilter: (req, file, cb) => {
    // Allow images and videos
    const allowedTypes = [
      'image/jpeg', 'image/png', 'image/gif', 'image/webp', 'image/svg+xml',
      'video/mp4', 'video/mpeg', 'video/quicktime', 'video/x-msvideo', 'video/webm'
    ];
    if (allowedTypes.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error('Only image and video files are allowed'), false);
    }
  }
});

// ==================== JWT CONFIGURATION ====================

const JWT_SECRET = process.env.JWT_SECRET;
const ADMIN_USERNAME = process.env.ADMIN_USERNAME;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;

// ==================== AUTHENTICATION MIDDLEWARE ====================

const authenticateToken = (req, res, next) => {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];

  if (!token) {
    return res.status(401).json({ message: 'Access token required' });
  }

  try {
    const user = jwt.verify(token, JWT_SECRET);
    req.user = user;
    next();
  } catch (err) {
    if (err.name === 'TokenExpiredError') {
      return res.status(403).json({ message: 'Token expired' });
    }
    return res.status(403).json({ message: 'Invalid token' });
  }
};

// ==================== FACE RECOGNITION HELPER FUNCTIONS ====================

// Helper function to extract face descriptor from image buffer
async function extractFaceDescriptor(imageBuffer) {
    if (!faceDetectionModelLoaded) {
        throw new Error('Face detection models not loaded');
    }

    try {
        // Decode image using canvas
        const img = new Image();
        img.src = imageBuffer;
        
        // Detect faces
        const detections = await faceapi.detectSingleFace(img)
            .withFaceLandmarks()
            .withFaceDescriptor();

        if (!detections) {
            throw new Error('No face detected in the image');
        }

        // Return face descriptor as array
        return Array.from(detections.descriptor);
    } catch (error) {
        throw new Error(`Face detection failed: ${error.message}`);
    }
}

// Helper function to compare two face descriptors
function compareFaces(descriptor1, descriptor2) {
    // Calculate Euclidean distance
    let sum = 0;
    for (let i = 0; i < descriptor1.length; i++) {
        sum += Math.pow(descriptor1[i] - descriptor2[i], 2);
    }
    const distance = Math.sqrt(sum);
    
    // Convert distance to similarity score (0-1)
    // Lower distance = higher similarity
    const similarity = Math.max(0, 1 - (distance / 1.5));
    return Math.min(1, similarity);
}

// ==================== API ROUTES ====================

// Health check
app.get('/api/health', (req, res) => {
  res.json({ 
    status: 'OK', 
    timestamp: new Date().toISOString(),
    environment: process.env.NODE_ENV || 'development',
    faceRecognition: faceDetectionModelLoaded ? 'enabled' : 'disabled'
  });
});

// ==================== AUTH ROUTES ====================

// Login
app.post('/api/login', [
  body('username').notEmpty().withMessage('Username is required').trim().escape(),
  body('password').notEmpty().withMessage('Password is required')
], async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ message: errors.array()[0].msg });
  }

  const { username, password, rememberMe } = req.body;

  try {
    // Check if user exists in Firestore
    const userSnapshot = await db.collection('users')
      .where('username', '==', username)
      .limit(1)
      .get();

    let userData = null;
    let userDocId = null;

    if (!userSnapshot.empty) {
      userDocId = userSnapshot.docs[0].id;
      userData = userSnapshot.docs[0].data();
    }

    // If no user found, check hardcoded admin from .env
    if (!userData) {
      if (username === ADMIN_USERNAME && password === ADMIN_PASSWORD) {
        // Create admin user in database if not exists
        const adminCheck = await db.collection('users')
          .where('username', '==', ADMIN_USERNAME)
          .limit(1)
          .get();

        if (adminCheck.empty) {
          const hashedPassword = await bcrypt.hash(ADMIN_PASSWORD, 10);
          await db.collection('users').add({
            username: ADMIN_USERNAME,
            password: hashedPassword,
            role: 'admin',
            createdAt: admin.firestore.FieldValue.serverTimestamp()
          });
        }

        const token = jwt.sign(
          { username: ADMIN_USERNAME, role: 'admin' },
          JWT_SECRET,
          { expiresIn: rememberMe ? '30d' : '24h' }
        );

        return res.json({ 
          token, 
          message: 'Login successful',
          user: { username: ADMIN_USERNAME, role: 'admin' }
        });
      }
      
      return res.status(401).json({ message: 'Invalid username or password' });
    }

    // Verify password
    const isValidPassword = await bcrypt.compare(password, userData.password);
    if (!isValidPassword) {
      return res.status(401).json({ message: 'Invalid username or password' });
    }

    // Generate token
    const token = jwt.sign(
      { username: userData.username, role: userData.role || 'admin' },
      JWT_SECRET,
      { expiresIn: rememberMe ? '30d' : '24h' }
    );

    res.json({ 
      token, 
      message: 'Login successful',
      user: { username: userData.username, role: userData.role || 'admin' }
    });
  } catch (error) {
    console.error('Login error:', error);
    res.status(500).json({ message: 'Server error during login' });
  }
});

// Logout
app.post('/api/logout', authenticateToken, (req, res) => {
  res.json({ message: 'Logged out successfully' });
});

// ==================== GALLERY ROUTES ====================

// GET gallery images
app.get('/api/gallery', async (req, res) => {
  try {
    const snapshot = await db.collection('gallery')
      .orderBy('createdAt', 'desc')
      .get();
    
    const images = [];
    snapshot.forEach(doc => {
      const data = doc.data();
      images.push({ 
        id: doc.id, 
        ...data,
        createdAt: data.createdAt ? data.createdAt.toDate().toISOString() : null
      });
    });
    res.json(images);
  } catch (error) {
    console.error('Error fetching gallery:', error);
    res.status(500).json({ message: 'Error fetching gallery' });
  }
});

// POST upload image with face detection
app.post('/api/gallery', authenticateToken, upload.single('image'), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ message: 'No image file provided' });
  }

  try {
    // Upload to Cloudinary
    const result = await new Promise((resolve, reject) => {
      const uploadStream = cloudinary.uploader.upload_stream(
        {
          folder: 'baptism-blessing/gallery',
          transformation: [
            { width: 1920, crop: 'limit', quality: 'auto' }
          ],
          public_id: `gallery_${uuidv4()}`
        },
        (error, result) => {
          if (error) reject(error);
          else resolve(result);
        }
      );
      uploadStream.end(req.file.buffer);
    });

    // Try to extract face descriptor (optional - continue even if fails)
    let faceDescriptor = null;
    if (faceDetectionModelLoaded) {
      try {
        faceDescriptor = await extractFaceDescriptor(req.file.buffer);
        console.log('✅ Face descriptor extracted successfully');
      } catch (faceError) {
        console.warn('⚠️ No face detected in uploaded image:', faceError.message);
        // Continue without face descriptor
      }
    } else {
      console.log('ℹ️ Face detection models not loaded, skipping face descriptor extraction');
    }

    // Save to Firestore with face descriptor if available
    const imageData = {
      url: result.secure_url,
      publicId: result.public_id,
      title: req.body.title || 'Image',
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      hasFace: faceDescriptor !== null
    };

    // Add face descriptor only if detected
    if (faceDescriptor) {
      imageData.faceDescriptor = faceDescriptor;
    }

    const docRef = await db.collection('gallery').add(imageData);
    
    res.status(201).json({ 
      message: 'Image uploaded successfully',
      id: docRef.id,
      url: result.secure_url,
      publicId: result.public_id,
      title: imageData.title,
      hasFace: faceDescriptor !== null,
      faceDetected: faceDescriptor !== null
    });
  } catch (error) {
    console.error('Error uploading image:', error);
    res.status(500).json({ message: 'Error uploading image' });
  }
});

// DELETE gallery image
app.delete('/api/gallery/:id', authenticateToken, async (req, res) => {
  const { id } = req.params;

  try {
    const doc = await db.collection('gallery').doc(id).get();
    if (!doc.exists) {
      return res.status(404).json({ message: 'Image not found' });
    }

    const imageData = doc.data();
    
    if (imageData.publicId) {
      await cloudinary.uploader.destroy(imageData.publicId);
    }

    await db.collection('gallery').doc(id).delete();
    res.json({ message: 'Image deleted successfully' });
  } catch (error) {
    console.error('Error deleting image:', error);
    res.status(500).json({ message: 'Error deleting image' });
  }
});

// ==================== FACE RECOGNITION ROUTES ====================

// GET all face descriptors (for client-side comparison)
app.get('/api/face-descriptors', async (req, res) => {
  try {
    const snapshot = await db.collection('gallery')
      .select('url', 'faceDescriptor', 'title')
      .get();
    
    const faceData = [];
    snapshot.forEach(doc => {
      const data = doc.data();
      if (data.faceDescriptor && data.faceDescriptor.length > 0) {
        faceData.push({
          id: doc.id,
          url: data.url,
          title: data.title || 'Image',
          faceDescriptor: data.faceDescriptor
        });
      }
    });
    
    res.json(faceData);
  } catch (error) {
    console.error('Error fetching face descriptors:', error);
    res.status(500).json({ message: 'Error fetching face descriptors' });
  }
});

// POST extract face descriptor from uploaded image (for admin uploads)
app.post('/api/face/extract', authenticateToken, upload.single('image'), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ message: 'No image file provided' });
  }

  try {
    const descriptor = await extractFaceDescriptor(req.file.buffer);
    res.json({ 
      success: true, 
      descriptor: descriptor,
      message: 'Face descriptor extracted successfully'
    });
  } catch (error) {
    console.error('Error extracting face descriptor:', error);
    res.status(400).json({ 
      success: false, 
      message: error.message 
    });
  }
});

// POST search for faces (client uploads photo, server compares)
app.post('/api/face/search', upload.single('faceImage'), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ message: 'No image file provided' });
  }

  try {
    // Check if face detection is available
    if (!faceDetectionModelLoaded) {
      return res.status(503).json({ 
        success: false, 
        message: 'Face recognition is currently unavailable. Please try again later.' 
      });
    }

    // Extract face descriptor from the uploaded image
    const targetDescriptor = await extractFaceDescriptor(req.file.buffer);
    
    // Get all images with face descriptors
    const snapshot = await db.collection('gallery')
      .select('url', 'faceDescriptor', 'title')
      .get();
    
    const matches = [];
    snapshot.forEach(doc => {
      const data = doc.data();
      if (data.faceDescriptor && data.faceDescriptor.length > 0) {
        const similarity = compareFaces(targetDescriptor, data.faceDescriptor);
        if (similarity > 0.6) { // Threshold for match
          matches.push({
            id: doc.id,
            url: data.url,
            title: data.title || 'Image',
            similarity: Math.round(similarity * 100) / 100
          });
        }
      }
    });

    // Sort by similarity (highest first)
    matches.sort((a, b) => b.similarity - a.similarity);

    res.json({
      success: true,
      matches: matches,
      count: matches.length,
      message: matches.length > 0 ? 'Faces found!' : 'No matching faces found'
    });
  } catch (error) {
    console.error('Error searching for faces:', error);
    res.status(400).json({ 
      success: false, 
      message: error.message 
    });
  }
});

// ==================== VIDEO ROUTES ====================

// GET videos
app.get('/api/videos', async (req, res) => {
  try {
    const snapshot = await db.collection('videos')
      .orderBy('createdAt', 'desc')
      .get();
    
    const videos = [];
    snapshot.forEach(doc => {
      const data = doc.data();
      videos.push({ 
        id: doc.id, 
        ...data,
        createdAt: data.createdAt ? data.createdAt.toDate().toISOString() : null
      });
    });
    res.json(videos);
  } catch (error) {
    console.error('Error fetching videos:', error);
    res.status(500).json({ message: 'Error fetching videos' });
  }
});

// POST upload video with extended timeout
app.post('/api/video', authenticateToken, [
    body('url').isURL().withMessage('Valid URL is required'),
    body('publicId').optional().isString(),
    body('title').optional().isString().trim(),
    body('description').optional().isString().trim()
], async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
        return res.status(400).json({ message: errors.array()[0].msg });
    }

    try {
        const videoData = {
            url: req.body.url,
            publicId: req.body.publicId || '',
            title: req.body.title || 'Video',
            description: req.body.description || '',
            createdAt: admin.firestore.FieldValue.serverTimestamp()
        };

        const docRef = await db.collection('videos').add(videoData);
        res.status(201).json({ 
            message: 'Video added successfully',
            id: docRef.id,
            ...videoData
        });
    } catch (error) {
        console.error('Error saving video:', error);
        res.status(500).json({ message: 'Error saving video' });
    }
});

// DELETE video
app.delete('/api/video/:id', authenticateToken, async (req, res) => {
  const { id } = req.params;

  try {
    const doc = await db.collection('videos').doc(id).get();
    if (!doc.exists) {
      return res.status(404).json({ message: 'Video not found' });
    }

    const videoData = doc.data();
    
    if (videoData.publicId) {
      await cloudinary.uploader.destroy(videoData.publicId, { resource_type: 'video' });
    }

    await db.collection('videos').doc(id).delete();
    res.json({ message: 'Video deleted successfully' });
  } catch (error) {
    console.error('Error deleting video:', error);
    res.status(500).json({ message: 'Error deleting video' });
  }
});

// ==================== HTML ROUTES (Clean URLs) ====================

// Serve index.html for root
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Serve login.html for /login
app.get('/login', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'login.html'));
});

// Serve dashboard.html for /dashboard
app.get('/dashboard', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'dashboard.html'));
});

// Serve gallery.html for /gallery
app.get('/gallery', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'gallery.html'));
});

// Serve videos.html for /videos
app.get('/videos', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'videos.html'));
});

// ==================== FALLBACK ROUTE ====================

app.get('*', (req, res) => {
  if (req.path.startsWith('/api/')) {
    return res.status(404).json({ message: 'API endpoint not found' });
  }
  res.redirect('/');
});

// ==================== ERROR HANDLING ====================

app.use((req, res, next) => {
  if (req.path.startsWith('/api/')) {
    res.status(404).json({ message: 'API endpoint not found' });
  } else {
    res.redirect('/');
  }
});

app.use((err, req, res, next) => {
  console.error('Server Error:', err);
  
  // Multer error handling
  if (err instanceof multer.MulterError) {
    if (err.code === 'FILE_TOO_LARGE') {
      return res.status(413).json({ message: 'File too large. Maximum size is 500MB' });
    }
    return res.status(400).json({ message: err.message });
  }

  // JWT error handling
  if (err.name === 'JsonWebTokenError') {
    return res.status(403).json({ message: 'Invalid token' });
  }

  if (err.name === 'TokenExpiredError') {
    return res.status(403).json({ message: 'Token expired' });
  }

  // Default error
  res.status(500).json({ 
    message: 'Internal server error',
    error: process.env.NODE_ENV === 'development' ? err.message : undefined
  });
});

// ==================== START SERVER ====================

app.listen(PORT, () => {
  console.log('=================================');
  console.log('🕊️  Baptism Blessing Server');
  console.log('=================================');
  console.log(`🚀 Server running on http://localhost:${PORT}`);
  console.log(`📱 Environment: ${process.env.NODE_ENV || 'development'}`);
  console.log(`🔐 JWT: ${JWT_SECRET ? 'Configured ✅' : 'Missing ❌'}`);
  console.log(`☁️  Cloudinary: ${process.env.CLOUDINARY_CLOUD_NAME ? 'Configured ✅' : 'Missing ❌'}`);
  console.log(`🔥 Firebase: ${firebaseConfig.project_id ? 'Configured ✅' : 'Missing ❌'}`);
  console.log(`🧠 Face Recognition: ${faceDetectionModelLoaded ? '✅ Loaded' : '❌ Disabled'}`);
  console.log('=================================');
  console.log('📋 Admin Credentials from .env:');
  console.log(`   Username: ${ADMIN_USERNAME}`);
  console.log(`   Password: ${ADMIN_PASSWORD}`);
  console.log('=================================');
  console.log('🌐 Clean URLs:');
  console.log(`   Home: http://localhost:${PORT}/`);
  console.log(`   Login: http://localhost:${PORT}/login`);
  console.log(`   Dashboard: http://localhost:${PORT}/dashboard`);
  console.log(`   Gallery: http://localhost:${PORT}/gallery`);
  console.log(`   Videos: http://localhost:${PORT}/videos`);
  console.log('=================================');
  console.log('📹 Video upload limit: 500MB');
  console.log('⏱️  Cloudinary timeout: 10 minutes');
  console.log('=================================');
  console.log('🧠 Face Recognition Endpoints:');
  console.log(`   GET  /api/face-descriptors - Get all face descriptors`);
  console.log(`   POST /api/face/extract - Extract face from image`);
  console.log(`   POST /api/face/search - Search for matching faces`);
  console.log('=================================');
});

module.exports = app;
