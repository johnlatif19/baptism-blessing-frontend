const admin = require('firebase-admin');

class FaceIndexManager {
  constructor() {
    this.db = admin.firestore();
  }

  // Check if an image has been indexed
  async isImageIndexed(imageId) {
    try {
      const doc = await this.db.collection('gallery').doc(imageId).get();
      if (!doc.exists) return false;
      
      const data = doc.data();
      return data.faces && data.faces.length > 0;
    } catch (error) {
      console.error('Error checking image index:', error);
      return false;
    }
  }

  // Get all indexed face IDs for an image
  async getFaceIdsForImage(imageId) {
    try {
      const doc = await this.db.collection('gallery').doc(imageId).get();
      if (!doc.exists) return [];
      
      const data = doc.data();
      return data.faces || [];
    } catch (error) {
      console.error('Error getting face IDs:', error);
      return [];
    }
  }

  // Get face details by face ID
  async getFaceDetails(faceId) {
    try {
      const doc = await this.db.collection('faceIndex').doc(faceId).get();
      if (!doc.exists) return null;
      return {
        id: doc.id,
        ...doc.data()
      };
    } catch (error) {
      console.error('Error getting face details:', error);
      return null;
    }
  }

  // Get all faces for multiple face IDs
  async getMultipleFaceDetails(faceIds) {
    try {
      if (faceIds.length === 0) return [];
      
      const faceSnapshot = await this.db.collection('faceIndex')
        .where('faceId', 'in', faceIds)
        .get();

      const faces = [];
      faceSnapshot.forEach(doc => {
        faces.push({
          id: doc.id,
          ...doc.data()
        });
      });
      return faces;
    } catch (error) {
      console.error('Error getting multiple face details:', error);
      return [];
    }
  }

  // Get images by face IDs with pagination
  async getImagesByFaceIds(faceIds, limit = 50, startAfter = null) {
    try {
      if (faceIds.length === 0) return {
        images: [],
        total: 0,
        hasMore: false
      };

      // Get unique image IDs from face data
      const faces = await this.getMultipleFaceDetails(faceIds);
      const imageIds = [...new Set(faces.map(f => f.imageId).filter(Boolean))];

      if (imageIds.length === 0) {
        return {
          images: [],
          total: 0,
          hasMore: false
        };
      }

      // Get gallery images
      let query = this.db.collection('gallery')
        .where('__name__', 'in', imageIds)
        .orderBy('createdAt', 'desc');

      if (startAfter) {
        const startDoc = await this.db.collection('gallery').doc(startAfter).get();
        if (startDoc.exists) {
          query = query.startAfter(startDoc);
        }
      }

      const snapshot = await query.limit(limit).get();
      
      const images = [];
      snapshot.forEach(doc => {
        const data = doc.data();
        images.push({
          id: doc.id,
          ...data,
          faceMatches: faces.filter(f => f.imageId === doc.id)
        });
      });

      const hasMore = images.length === limit;

      return {
        images: images,
        total: imageIds.length,
        hasMore: hasMore,
        lastId: images.length > 0 ? images[images.length - 1].id : null
      };
    } catch (error) {
      console.error('Error getting images by face IDs:', error);
      return {
        images: [],
        total: 0,
        hasMore: false
      };
    }
  }

  // Get face statistics
  async getFaceStatistics() {
    try {
      const faceSnapshot = await this.db.collection('faceIndex').get();
      
      let totalFaces = 0;
      let highQualityFaces = 0;
      let confidenceSum = 0;

      faceSnapshot.forEach(doc => {
        const data = doc.data();
        totalFaces++;
        if (data.confidence && data.confidence > 80) {
          highQualityFaces++;
        }
        if (data.confidence) {
          confidenceSum += data.confidence;
        }
      });

      return {
        totalFaces: totalFaces,
        highQualityFaces: highQualityFaces,
        averageConfidence: totalFaces > 0 ? confidenceSum / totalFaces : 0,
        uniqueImages: new Set(
          faceSnapshot.docs.map(doc => doc.data().imageId).filter(Boolean)
        ).size
      };
    } catch (error) {
      console.error('Error getting face statistics:', error);
      return null;
    }
  }

  // Clean up orphaned face records
  async cleanupOrphanedFaces() {
    try {
      const faceSnapshot = await this.db.collection('faceIndex').get();
      const toDelete = [];

      for (const doc of faceSnapshot.docs) {
        const data = doc.data();
        if (data.imageId) {
          const imageDoc = await this.db.collection('gallery').doc(data.imageId).get();
          if (!imageDoc.exists) {
            toDelete.push(doc.id);
          }
        }
      }

      if (toDelete.length > 0) {
        const batch = this.db.batch();
        for (const faceId of toDelete) {
          const ref = this.db.collection('faceIndex').doc(faceId);
          batch.delete(ref);
        }
        await batch.commit();
      }

      return {
        success: true,
        deletedCount: toDelete.length
      };
    } catch (error) {
      console.error('Error cleaning up orphaned faces:', error);
      return {
        success: false,
        error: error.message
      };
    }
  }
}

module.exports = FaceIndexManager;
