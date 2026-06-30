#!/usr/bin/env python3
"""
استخراج Embedding من صورة واحدة للبحث
"""

import sys
import json
import cv2
import numpy as np
from pathlib import Path
import insightface
from insightface.app import FaceAnalysis

def main():
    if len(sys.argv) < 2:
        print(json.dumps({'error': 'No image path provided'}))
        sys.exit(1)
    
    image_path = sys.argv[1]
    
    try:
        # تهيئة InsightFace
        app = FaceAnalysis(name='buffalo_l', providers=['CPUExecutionProvider'])
        app.prepare(ctx_id=0, det_size=(640, 640))
        
        # قراءة الصورة
        img = cv2.imread(image_path)
        if img is None:
            print(json.dumps({'error': 'Cannot read image'}))
            sys.exit(1)
        
        # اكتشاف الوجوه
        faces = app.get(img)
        
        if len(faces) == 0:
            print(json.dumps({'error': 'No face detected in the image'}))
            sys.exit(1)
        
        # اختيار أفضل وجه (أعلى درجة ثقة)
        best_face = max(faces, key=lambda x: x.det_score if hasattr(x, 'det_score') else 0)
        
        # استخراج الـ Embedding
        embedding = best_face.normed_embedding
        
        if embedding is None:
            print(json.dumps({'error': 'Failed to extract face embedding'}))
            sys.exit(1)
        
        # إرجاع النتيجة
        result = {
            'embedding': embedding.tolist(),
            'bbox': best_face.bbox.tolist() if hasattr(best_face, 'bbox') else None,
            'det_score': float(best_face.det_score) if hasattr(best_face, 'det_score') else 1.0,
            'face_count': len(faces)
        }
        
        print(json.dumps(result))
        
    except Exception as e:
        print(json.dumps({'error': str(e)}))
        sys.exit(1)

if __name__ == '__main__':
    main()
