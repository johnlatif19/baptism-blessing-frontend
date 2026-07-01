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

// ==================== FACE DETECTION IMPORTS ====================
const faceDetection = require('./server/faceDetection');

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

// JSON and URL encoded
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

    if (!userData) {
      if (username === ADMIN_USERNAME && password === ADMIN_PASSWORD) {
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

    const isValidPassword = await bcrypt.compare(password, userData.password);
    if (!isValidPassword) {
      return res.status(401).json({ message: 'Invalid username or password' });
    }

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

// POST upload video
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

// POST search for similar faces
app.post('/api/search-face', upload.single('image'), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ message: 'No image file provided' });
  }

  try {
    await faceDetection.loadModels();
    
    const faceData = await faceDetection.detectFacesAndEmbeddings(req.file.buffer);
    
    if (!faceData || faceData.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'No faces detected in the uploaded image'
      });
    }

    const gallerySnapshot = await db.collection('gallery')
      .where('faces', '!=', null)
      .get();
    
    const allStoredEmbeddings = [];
    const imageMap = {};
    
    gallerySnapshot.forEach(doc => {
      const data = doc.data();
      imageMap[doc.id] = {
        id: doc.id,
        url: data.url,
        publicId: data.publicId,
        title: data.title || 'Image',
        createdAt: data.createdAt ? data.createdAt.toDate().toISOString() : null
      };
      
      if (data.faces && Array.isArray(data.faces)) {
        data.faces.forEach((face, index) => {
          if (face.embedding && Array.isArray(face.embedding) && face.embedding.length > 0) {
            allStoredEmbeddings.push({
              embedding: face.embedding,
              imageId: doc.id,
              faceIndex: index,
              metadata: {
                title: data.title || 'Image',
                url: data.url
              }
            });
          }
        });
      }
    });

    const threshold = parseFloat(req.query.threshold) || 0.5;
    const normalizedThreshold = Math.max(0, Math.min(1, threshold));

    const queryEmbedding = faceData[0].embedding;
    const matches = faceDetection.compareEmbeddings(
      queryEmbedding,
      allStoredEmbeddings,
      normalizedThreshold
    );

    const imageMatches = {};
    for (const match of matches) {
      if (!imageMatches[match.imageId] || match.similarity > imageMatches[match.imageId].similarity) {
        imageMatches[match.imageId] = {
          similarity: match.similarity,
          image: imageMap[match.imageId] || { id: match.imageId }
        };
      }
    }

    const resultMatches = Object.values(imageMatches)
      .sort((a, b) => b.similarity - a.similarity);

    res.json({
      success: true,
      facesDetected: faceData.length,
      matches: resultMatches,
      threshold: normalizedThreshold
    });

  } catch (error) {
    console.error('Error during face search:', error);
    res.status(500).json({ 
      success: false,
      message: 'Error during face search',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
});

// GET check if face detection is ready
app.get('/api/face-detection-status', async (req, res) => {
  try {
    await faceDetection.loadModels();
    res.json({
      status: 'ready',
      message: 'Face detection models are loaded and ready'
    });
  } catch (error) {
    res.status(503).json({
      status: 'unavailable',
      message: 'Face detection models are not loaded',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
});

// POST update gallery image with face embeddings
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

    const response = await fetch(imageData.url);
    const buffer = Buffer.from(await response.arrayBuffer());

    const faceData = await faceDetection.extractFaceEmbeddings(buffer, {
      title: imageData.title || 'Image',
      url: imageData.url
    });

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
      message: `Face embeddings generated for ${faceData.length} faces`,
      faceCount: faceData.length
    });

  } catch (error) {
    console.error('Error generating face embeddings:', error);
    res.status(500).json({ 
      success: false,
      message: 'Error generating face embeddings',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
});

// POST batch process all gallery images for face detection
app.post('/api/gallery/batch-process-faces', authenticateToken, async (req, res) => {
  try {
    const snapshot = await db.collection('gallery')
      .where('faces', '==', null)
      .limit(50)
      .get();

    if (snapshot.empty) {
      return res.json({
        success: true,
        message: 'No images without face embeddings found',
        processed: 0
      });
    }

    const results = [];
    for (const doc of snapshot.docs) {
      try {
        const data = doc.data();
        if (!data.url) continue;

        const response = await fetch(data.url);
        const buffer = Buffer.from(await response.arrayBuffer());

        const faceData = await faceDetection.extractFaceEmbeddings(buffer, {
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

        results.push({
          id: doc.id,
          success: true,
          faceCount: faceData.length
        });

      } catch (error) {
        results.push({
          id: doc.id,
          success: false,
          error: error.message
        });
      }
    }

    res.json({
      success: true,
      message: `Processed ${results.length} images`,
      results: results
    });

  } catch (error) {
    console.error('Error batch processing faces:', error);
    res.status(500).json({
      success: false,
      message: 'Error batch processing faces',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
});

// ==================== HTML ROUTES (Clean URLs) ====================

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('/login', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'login.html'));
});

app.get('/dashboard', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'dashboard.html'));
});

app.get('/gallery', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'gallery.html'));
});

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
  
  if (err instanceof multer.MulterError) {
    if (err.code === 'FILE_TOO_LARGE') {
      return res.status(413).json({ message: 'File too large. Maximum size is 500MB' });
    }
    return res.status(400).json({ message: err.message });
  }

  if (err.name === 'JsonWebTokenError') {
    return res.status(403).json({ message: 'Invalid token' });
  }

  if (err.name === 'TokenExpiredError') {
    return res.status(403).json({ message: 'Token expired' });
  }

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
  console.log(`   Models: Will load on first request`);
  console.log('=================================');
});

module.exports = app;
