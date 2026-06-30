const {
  RekognitionClient,
  IndexFacesCommand,
  SearchFacesByImageCommand,
  DetectFacesCommand,
  ListCollectionsCommand,
  CreateCollectionCommand,
  DeleteCollectionCommand,
  DeleteFacesCommand
} = require('@aws-sdk/client-rekognition');

const {
  S3Client,
  PutObjectCommand,
  DeleteObjectCommand,
  HeadObjectCommand
} = require('@aws-sdk/client-s3');

const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
const sharp = require('sharp');
const crypto = require('crypto');
const admin = require('firebase-admin');

class FaceRecognitionService {
  constructor() {
    // Initialize AWS clients
    this.rekognition = new RekognitionClient({
      region: process.env.AWS_REGION || 'us-east-1',
      credentials: {
        accessKeyId: process.env.AWS_ACCESS_KEY_ID,
        secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY
      }
    });

    this.s3 = new S3Client({
      region: process.env.AWS_REGION || 'us-east-1',
      credentials: {
        accessKeyId: process.env.AWS_ACCESS_KEY_ID,
        secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY
      }
    });

    this.collectionId = process.env.AWS_REKOGNITION_COLLECTION || 'baptism-blessing-faces';
    this.bucketName = process.env.AWS_S3_BUCKET;
    this.db = admin.firestore();
  }

  // Initialize collection
  async initializeCollection() {
    try {
      // Check if collection exists
      const collections = await this.rekognition.send(
        new ListCollectionsCommand({})
      );

      if (!collections.CollectionIds.includes(this.collectionId)) {
        await this.rekognition.send(
          new CreateCollectionCommand({
            CollectionId: this.collectionId
          })
        );
        console.log(`✅ Created collection: ${this.collectionId}`);
      } else {
        console.log(`✅ Collection already exists: ${this.collectionId}`);
      }
      return true;
    } catch (error) {
      console.error('Error initializing collection:', error);
      throw error;
    }
  }

  // Index faces from a gallery image
  async indexFacesFromImage(imageUrl, imageId, metadata = {}) {
    try {
      // Download image from Cloudinary or URL
      const imageBuffer = await this.downloadImage(imageUrl);
      
      // Optimize image for Rekognition
      const optimizedBuffer = await sharp(imageBuffer)
        .resize(1024, 1024, { fit: 'inside' })
        .jpeg({ quality: 80 })
        .toBuffer();

      // Upload to S3 for Rekognition
      const s3Key = `temp/${imageId}_${Date.now()}.jpg`;
      await this.s3.send(
        new PutObjectCommand({
          Bucket: this.bucketName,
          Key: s3Key,
          Body: optimizedBuffer,
          ContentType: 'image/jpeg'
        })
      );

      // Index faces
      const command = new IndexFacesCommand({
        CollectionId: this.collectionId,
        Image: {
          S3Object: {
            Bucket: this.bucketName,
            Name: s3Key
          }
        },
        DetectionAttributes: ['DEFAULT'],
        MaxFaces: 100,
        QualityFilter: 'AUTO'
      });

      const response = await this.rekognition.send(command);
      
      // Clean up S3 temp file
      await this.s3.send(
        new DeleteObjectCommand({
          Bucket: this.bucketName,
          Key: s3Key
        })
      );

      // Store face records in Firestore
      const faceRecords = response.FaceRecords || [];
      const indexedFaces = [];

      for (const record of faceRecords) {
        if (record.Face && record.Face.FaceId) {
          const faceId = record.Face.FaceId;
          const faceData = {
            faceId: faceId,
            imageId: imageId,
            imageUrl: imageUrl,
            boundingBox: record.Face.BoundingBox || null,
            confidence: record.Face.Confidence || 0,
            quality: record.Face.Quality || null,
            indexedAt: admin.firestore.FieldValue.serverTimestamp(),
            metadata: metadata
          };

          // Store in Firestore
          await this.db.collection('faceIndex').doc(faceId).set(faceData);
          
          // Also store reference in gallery image
          await this.db.collection('gallery').doc(imageId).update({
            faces: admin.firestore.FieldValue.arrayUnion(faceId)
          });

          indexedFaces.push(faceData);
        }
      }

      return {
        success: true,
        indexedCount: indexedFaces.length,
        faces: indexedFaces,
        unindexedFaces: response.UnindexedFaces || []
      };
    } catch (error) {
      console.error('Error indexing faces:', error);
      throw error;
    }
  }

  // Search for faces matching an uploaded image
  async searchFacesByImage(imageBuffer, maxFaces = 100, faceMatchThreshold = 70) {
    try {
      // Optimize image
      const optimizedBuffer = await sharp(imageBuffer)
        .resize(1024, 1024, { fit: 'inside' })
        .jpeg({ quality: 80 })
        .toBuffer();

      // Upload to S3 for Rekognition
      const s3Key = `search/${crypto.randomUUID()}.jpg`;
      await this.s3.send(
        new PutObjectCommand({
          Bucket: this.bucketName,
          Key: s3Key,
          Body: optimizedBuffer,
          ContentType: 'image/jpeg'
        })
      );

      // Search faces
      const command = new SearchFacesByImageCommand({
        CollectionId: this.collectionId,
        Image: {
          S3Object: {
            Bucket: this.bucketName,
            Name: s3Key
          }
        },
        MaxFaces: maxFaces,
        FaceMatchThreshold: faceMatchThreshold
      });

      const response = await this.rekognition.send(command);
      
      // Clean up
      await this.s3.send(
        new DeleteObjectCommand({
          Bucket: this.bucketName,
          Key: s3Key
        })
      );

      // Get detailed face information from Firestore
      const matchedFaces = [];
      const faceIds = response.FaceMatches.map(match => match.Face.FaceId);
      
      if (faceIds.length > 0) {
        const faceSnapshot = await this.db.collection('faceIndex')
          .where('faceId', 'in', faceIds)
          .get();

        const faceDataMap = {};
        faceSnapshot.forEach(doc => {
          faceDataMap[doc.id] = doc.data();
        });

        // Get unique image IDs
        const imageIds = new Set();
        const faceMatches = [];

        for (const match of response.FaceMatches) {
          const faceId = match.Face.FaceId;
          const faceData = faceDataMap[faceId];
          
          if (faceData) {
            imageIds.add(faceData.imageId);
            faceMatches.push({
              faceId: faceId,
              similarity: match.Similarity,
              imageId: faceData.imageId,
              imageUrl: faceData.imageUrl,
              boundingBox: faceData.boundingBox,
              confidence: faceData.confidence
            });
          }
        }

        // Get gallery image details
        const imageDetails = {};
        if (imageIds.size > 0) {
          const imageSnapshot = await this.db.collection('gallery')
            .where('__name__', 'in', Array.from(imageIds))
            .get();

          imageSnapshot.forEach(doc => {
            imageDetails[doc.id] = {
              id: doc.id,
              ...doc.data()
            };
          });
        }

        // Build final result
        for (const match of faceMatches) {
          const imageDetail = imageDetails[match.imageId];
          if (imageDetail) {
            matchedFaces.push({
              ...match,
              image: imageDetail
            });
          }
        }
      }

      return {
        success: true,
        matches: matchedFaces,
        matchedCount: matchedFaces.length,
        searchFacesCount: response.SearchedFaceBoundingBox ? 1 : 0
      };
    } catch (error) {
      console.error('Error searching faces:', error);
      throw error;
    }
  }

  // Detect faces in an image
  async detectFaces(imageBuffer) {
    try {
      const optimizedBuffer = await sharp(imageBuffer)
        .resize(1024, 1024, { fit: 'inside' })
        .jpeg({ quality: 80 })
        .toBuffer();

      // Upload to S3
      const s3Key = `detect/${crypto.randomUUID()}.jpg`;
      await this.s3.send(
        new PutObjectCommand({
          Bucket: this.bucketName,
          Key: s3Key,
          Body: optimizedBuffer,
          ContentType: 'image/jpeg'
        })
      );

      const command = new DetectFacesCommand({
        Image: {
          S3Object: {
            Bucket: this.bucketName,
            Name: s3Key
          }
        },
        Attributes: ['DEFAULT']
      });

      const response = await this.rekognition.send(command);

      // Clean up
      await this.s3.send(
        new DeleteObjectCommand({
          Bucket: this.bucketName,
          Key: s3Key
        })
      );

      return {
        success: true,
        faceCount: response.FaceDetails ? response.FaceDetails.length : 0,
        faces: response.FaceDetails || []
      };
    } catch (error) {
      console.error('Error detecting faces:', error);
      throw error;
    }
  }

  // Download image from URL
  async downloadImage(url) {
    try {
      const response = await fetch(url);
      if (!response.ok) {
        throw new Error(`Failed to download image: ${response.statusText}`);
      }
      const buffer = await response.arrayBuffer();
      return Buffer.from(buffer);
    } catch (error) {
      console.error('Error downloading image:', error);
      throw error;
    }
  }

  // Delete faces for a specific image
  async deleteFacesByImageId(imageId) {
    try {
      // Get all faces for this image
      const faceSnapshot = await this.db.collection('faceIndex')
        .where('imageId', '==', imageId)
        .get();

      const faceIds = [];
      faceSnapshot.forEach(doc => {
        faceIds.push(doc.id);
      });

      if (faceIds.length > 0) {
        // Delete from Rekognition
        await this.rekognition.send(
          new DeleteFacesCommand({
            CollectionId: this.collectionId,
            FaceIds: faceIds
          })
        );

        // Delete from Firestore
        const batch = this.db.batch();
        faceSnapshot.forEach(doc => {
          batch.delete(doc.ref);
        });
        await batch.commit();
      }

      // Remove face references from gallery
      await this.db.collection('gallery').doc(imageId).update({
        faces: []
      });

      return {
        success: true,
        deletedCount: faceIds.length
      };
    } catch (error) {
      console.error('Error deleting faces:', error);
      throw error;
    }
  }

  // Reindex all gallery images
  async reindexAllGallery() {
    try {
      const snapshot = await this.db.collection('gallery').get();
      const results = [];

      for (const doc of snapshot.docs) {
        const data = doc.data();
        if (data.url) {
          try {
            const result = await this.indexFacesFromImage(
              data.url,
              doc.id,
              { title: data.title || 'Gallery image' }
            );
            results.push({
              imageId: doc.id,
              success: true,
              indexedCount: result.indexedCount
            });
          } catch (error) {
            results.push({
              imageId: doc.id,
              success: false,
              error: error.message
            });
          }
        }
      }

      return {
        success: true,
        totalImages: snapshot.size,
        results: results
      };
    } catch (error) {
      console.error('Error reindexing gallery:', error);
      throw error;
    }
  }

  // Get collection statistics
  async getCollectionStats() {
    try {
      const faceSnapshot = await this.db.collection('faceIndex').get();
      const gallerySnapshot = await this.db.collection('gallery').get();

      return {
        totalFaces: faceSnapshot.size,
        totalImages: gallerySnapshot.size,
        collectionId: this.collectionId
      };
    } catch (error) {
      console.error('Error getting collection stats:', error);
      throw error;
    }
  }
}

module.exports = FaceRecognitionService;
