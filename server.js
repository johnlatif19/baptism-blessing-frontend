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

// ==================== FACE DETECTION ====================
// باستخدام @vladmandic/face-api - شغال على Node.js 24 بدون canvas
const faceapi = require('@vladmandic/face-api');
const fs = require('fs');
const https = require('https');

// ==================== MODEL DOWNLOAD FUNCTIONS ====================
const MODELS_DIR = path.join(__dirname, 'models');
const MODEL_FILES = [
  'ssd_mobilenetv1_model-weights_manifest.json',
  'ssd_mobilenetv1_model-shard1',
  'ssd_mobilenetv1_model-shard2',
  'face_landmark_68_model-weights_manifest.json',
  'face_landmark_68_model-shard1',
  'face_recognition_model-weights_manifest.json',
  'face_recognition_model-shard1',
  'face_recognition_model-shard2'
];

async function downloadFile(url, filePath) {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(filePath);
    https.get(url, (response) => {
      if (response.statusCode !== 200) {
        reject(new Error(`Failed: ${response.statusCode}`));
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

async function downloadModelsIfNeeded() {
  if (!fs.existsSync(MODELS_DIR)) {
    fs.mkdirSync(MODELS_DIR, { recursive: true });
  }

  for (const file of MODEL_FILES) {
    const filePath = path.join(MODELS_DIR, file);
    if (!fs.existsSync(filePath)) {
      const url = `https://raw.githubusercontent.com/justadudewhohacks/face-api.js/master/weights/${file}`;
      console.log(`⬇️ Downloading ${file}...`);
      try {
        await downloadFile(url, filePath);
        console.log(`✅ Downloaded ${file}`);
      } catch (error) {
        console.error(`❌ Failed ${file}:`, error.message);
      }
    }
  }
}

// ==================== FACE DETECTION LOGIC ====================
let modelsLoaded = false;

async function loadModels() {
  if (modelsLoaded) return;
  
  await downloadModelsIfNeeded();
  
  try {
    console.log('🔄 Loading face detection models...');
    await faceapi.nets.ssdMobilenetv1.loadFromDisk(MODELS_DIR);
    await faceapi.nets.faceLandmark68Net.loadFromDisk(MODELS_DIR);
    await faceapi.nets.faceRecognitionNet.loadFromDisk(MODELS_DIR);
    modelsLoaded = true;
    console.log('✅ Face detection models loaded');
  } catch (error) {
    console.error('❌ Error loading models:', error.message);
    throw error;
  }
}

async function detectFacesAndEmbeddings(imageBuffer) {
  try {
    await loadModels();
    
    // تحويل الصورة من Buffer باستخدام @vladmandic/face-api
    const img = await faceapi.bufferToImage(imageBuffer);
    
    const detections = await faceapi.detectAllFaces(img, new faceapi.SsdMobilenetv1Options({
      minConfidence: 0.5
    })).withFaceLandmarks().withFaceDescriptors();
    
    if (!detections || detections.length === 0) return [];
    
    return detections.map(detection => ({
      embedding: Array.from(detection.descriptor),
      detection: {
        x: detection.detection.box.x,
        y: detection.detection.box.y,
        width: detection.detection.box.width,
        height: detection.detection.box.height
      }
    }));
  } catch (error) {
    console.error('Error detecting faces:', error);
    return [];
  }
}

function calculateDistance(embedding1, embedding2) {
  let sum = 0;
  for (let i = 0; i < embedding1.length; i++) {
    const diff = embedding1[i] - embedding2[i];
    sum += diff * diff;
  }
  return Math.sqrt(sum);
}

function distanceToSimilarity(distance) {
  const similarity = Math.max(0, 1 - distance);
  return Math.round(similarity * 100) / 100;
}

function compareEmbeddings(queryEmbedding, storedEmbeddings, threshold = 0.5) {
  const results = [];
  for (const stored of storedEmbeddings) {
    const distance = calculateDistance(queryEmbedding, stored.embedding);
    const similarity = distanceToSimilarity(distance);
    if (similarity >= threshold) {
      results.push({
        similarity: similarity,
        imageId: stored.imageId,
        metadata: stored.metadata || {}
      });
    }
  }
  results.sort((a, b) => b.similarity - a.similarity);
  return results;
}

async function extractFaceEmbeddings(imageBuffer, metadata = {}) {
  const faceData = await detectFacesAndEmbeddings(imageBuffer);
  return faceData.map((face, index) => ({
    embedding: face.embedding,
    metadata: { ...metadata, faceIndex: index }
  }));
}

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
      scriptSrc: ["'self'", "'unsafe-inline'", "https://api.qrserver.com"],
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

// ==================== API ROUTES ====================

// Health check
app.get('/api/health', (req, res) => {
  res.json({ 
    status: 'OK', 
    timestamp: new Date().toISOString(),
    environment: process.env.NODE_ENV || 'development'
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

// POST upload image
app.post('/api/gallery', authenticateToken, upload.single('image'), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ message: 'No image file provided' });
  }

  try {
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

    const imageData = {
      url: result.secure_url,
      publicId: result.public_id,
      title: req.body.title || 'Image',
      createdAt: admin.firestore.FieldValue.serverTimestamp()
    };

    const docRef = await db.collection('gallery').add(imageData);
    res.status(201).json({ 
      message: 'Image uploaded successfully',
      id: docRef.id,
      url: result.secure_url,
      publicId: result.public_id,
      title: imageData.title
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

// ==================== FACE SEARCH ROUTES ====================

// POST - البحث بالوجه
app.post('/api/search-face', upload.single('image'), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ message: 'No image provided' });
  }

  try {
    // كشف الوجوه في الصورة المرفوعة
    const faceData = await detectFacesAndEmbeddings(req.file.buffer);
    
    if (!faceData || faceData.length === 0) {
      return res.json({
        success: false,
        message: 'No faces detected'
      });
    }

    // جلب الصور من Firestore
    const snapshot = await db.collection('gallery')
      .where('faces', '!=', null)
      .get();

    // تجميع التضمينات المخزنة
    const storedEmbeddings = [];
    const imageMap = {};

    snapshot.forEach(doc => {
      const data = doc.data();
      imageMap[doc.id] = {
        id: doc.id,
        url: data.url,
        title: data.title || 'Image'
      };

      if (data.faces && Array.isArray(data.faces)) {
        data.faces.forEach(face => {
          if (face.embedding && face.embedding.length > 0) {
            storedEmbeddings.push({
              embedding: face.embedding,
              imageId: doc.id,
              metadata: { title: data.title, url: data.url }
            });
          }
        });
      }
    });

    // المقارنة
    const queryEmbedding = faceData[0].embedding;
    const matches = compareEmbeddings(
      queryEmbedding,
      storedEmbeddings,
      0.5
    );

    // تجميع النتائج
    const resultMatches = [];
    const seenImages = new Set();

    for (const match of matches) {
      if (!seenImages.has(match.imageId)) {
        seenImages.add(match.imageId);
        resultMatches.push({
          similarity: match.similarity,
          image: imageMap[match.imageId] || { id: match.imageId }
        });
      }
    }

    res.json({
      success: true,
      facesDetected: faceData.length,
      matches: resultMatches
    });

  } catch (error) {
    console.error('Search error:', error);
    res.status(500).json({
      success: false,
      message: 'Error during face search'
    });
  }
});

// POST - معالجة صورة واحدة (توليد التضمينات) - يتطلب توثيق
app.post('/api/gallery/:id/faces', authenticateToken, async (req, res) => {
  const { id } = req.params;
  
  try {
    const doc = await db.collection('gallery').doc(id).get();
    if (!doc.exists) {
      return res.status(404).json({ message: 'Image not found' });
    }

    const imageData = doc.data();
    if (!imageData.url) {
      return res.status(400).json({ message: 'Image URL not found' });
    }

    // تحميل الصورة من Cloudinary
    const response = await fetch(imageData.url);
    const buffer = Buffer.from(await response.arrayBuffer());

    // كشف الوجوه
    const faceData = await extractFaceEmbeddings(buffer, {
      title: imageData.title || 'Image',
      url: imageData.url
    });

    // حفظ التضمينات
    await db.collection('gallery').doc(id).update({
      faces: faceData.map(face => ({
        embedding: face.embedding,
        metadata: face.metadata
      })),
      faceCount: faceData.length,
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    });

    res.json({
      success: true,
      message: `Generated embeddings for ${faceData.length} faces`,
      faceCount: faceData.length
    });

  } catch (error) {
    console.error('Error:', error);
    res.status(500).json({
      success: false,
      message: 'Error generating face embeddings'
    });
  }
});

// POST - معالجة جميع الصور دفعة واحدة - يتطلب توثيق
app.post('/api/gallery/batch-process-faces', authenticateToken, async (req, res) => {
  try {
    const snapshot = await db.collection('gallery')
      .where('faces', '==', null)
      .limit(20)
      .get();

    if (snapshot.empty) {
      return res.json({
        success: true,
        message: 'All images already processed',
        processed: 0
      });
    }

    let processed = 0;
    for (const doc of snapshot.docs) {
      try {
        const data = doc.data();
        if (!data.url) continue;

        const response = await fetch(data.url);
        const buffer = Buffer.from(await response.arrayBuffer());

        const faceData = await extractFaceEmbeddings(buffer, {
          title: data.title || 'Image',
          url: data.url
        });

        await db.collection('gallery').doc(doc.id).update({
          faces: faceData.map(face => ({
            embedding: face.embedding,
            metadata: face.metadata
          })),
          faceCount: faceData.length,
          updatedAt: admin.firestore.FieldValue.serverTimestamp()
        });

        processed++;
      } catch (error) {
        console.error(`Error processing ${doc.id}:`, error);
      }
    }

    res.json({
      success: true,
      message: `Processed ${processed} images`,
      processed: processed
    });

  } catch (error) {
    console.error('Batch error:', error);
    res.status(500).json({
      success: false,
      message: 'Error processing images'
    });
  }
});

// GET - التحقق من حالة كشف الوجوه
app.get('/api/face-status', async (req, res) => {
  try {
    await loadModels();
    res.json({
      status: 'ready',
      message: 'Face detection is ready'
    });
  } catch (error) {
    res.status(503).json({
      status: 'unavailable',
      message: 'Face detection not ready'
    });
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
  console.log('👤 Face Detection:');
  console.log(`   Status: Enabled ✅`);
  console.log(`   Models: Will download on first request`);
  console.log('=================================');
});

module.exports = app;
