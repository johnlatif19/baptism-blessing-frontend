#!/usr/bin/env python3
"""
استخراج Face Embeddings من جميع صور المعمودية المخزنة في Cloudinary
"""

import os
import sys
import json
import cv2
import numpy as np
import requests
from io import BytesIO
from pathlib import Path
import insightface
from insightface.app import FaceAnalysis
import argparse
from datetime import datetime
import traceback
import time

# إعدادات
EMBEDDINGS_FILE = 'embeddings/gallery_embeddings.json'
TEMP_IMAGE_DIR = 'temp_images'

def download_image_from_cloudinary(url, save_path):
    """
    تحميل الصورة من Cloudinary لحفظها مؤقتاً
    """
    try:
        response = requests.get(url, timeout=30)
        if response.status_code == 200:
            with open(save_path, 'wb') as f:
                f.write(response.content)
            return True
        else:
            print(f"⚠️  Failed to download: {url} - Status: {response.status_code}")
            return False
    except Exception as e:
        print(f"⚠️  Error downloading {url}: {e}")
        return False

def get_face_embeddings(image_path, app):
    """
    استخراج Embeddings من جميع الوجوه في الصورة
    """
    try:
        img = cv2.imread(image_path)
        if img is None:
            print(f"⚠️  Cannot read image: {image_path}")
            return [], None

        # اكتشاف الوجوه
        faces = app.get(img)
        
        if len(faces) == 0:
            print(f"⚠️  No faces found in: {image_path}")
            return [], img

        embeddings = []
        for face in faces:
            embedding = face.normed_embedding
            if embedding is not None:
                embeddings.append({
                    'embedding': embedding.tolist(),
                    'bbox': face.bbox.tolist() if hasattr(face, 'bbox') else None,
                    'det_score': float(face.det_score) if hasattr(face, 'det_score') else 1.0
                })
        
        return embeddings, img
    except Exception as e:
        print(f"❌ Error processing {image_path}: {e}")
        return [], None

def extract_embeddings_from_images(images_data, app):
    """
    استخراج Embeddings من قائمة الصور
    """
    results = []
    temp_dir = Path(TEMP_IMAGE_DIR)
    temp_dir.mkdir(exist_ok=True)
    
    total = len(images_data)
    print(f"\n📸 Processing {total} images...")
    
    for idx, image_info in enumerate(images_data, 1):
        print(f"  [{idx}/{total}] Processing: {image_info.get('title', 'Untitled')}")
        
        # تحميل الصورة من Cloudinary
        temp_path = temp_dir / f"temp_{idx}_{int(time.time())}.jpg"
        
        if not download_image_from_cloudinary(image_info['url'], str(temp_path)):
            continue
        
        # استخراج الـ Embeddings
        embeddings, img = get_face_embeddings(str(temp_path), app)
        
        # حذف الملف المؤقت
        try:
            os.remove(str(temp_path))
        except:
            pass
        
        if embeddings:
            results.append({
                'image_id': image_info.get('id', ''),
                'url': image_info['url'],
                'public_id': image_info.get('publicId', ''),
                'title': image_info.get('title', ''),
                'faces': embeddings,
                'face_count': len(embeddings)
            })
            
    return results

def main():
    parser = argparse.ArgumentParser(description='Extract face embeddings from gallery images')
    parser.add_argument('--input', type=str, help='JSON file with image data (from API)')
    parser.add_argument('--threshold', type=float, default=0.6, help='Face detection threshold')
    parser.add_argument('--model', type=str, default='buffalo_l', help='InsightFace model')
    args = parser.parse_args()

    print("=" * 60)
    print("🕊️  Baptism Blessing - Face Embeddings Extractor")
    print("=" * 60)

    # تحميل البيانات من stdin إذا لم يتم تحديد ملف
    if args.input:
        with open(args.input, 'r') as f:
            images_data = json.load(f)
    else:
        # قراءة من stdin
        input_data = sys.stdin.read()
        if not input_data:
            print("❌ No input data provided")
            sys.exit(1)
        images_data = json.loads(input_data)

    if not images_data:
        print("❌ No images data provided")
        sys.exit(1)

    print(f"\n✅ Loaded {len(images_data)} images from Cloudinary")

    # تهيئة InsightFace
    print(f"\n🔧 Initializing InsightFace with model: {args.model}")
    try:
        app = FaceAnalysis(name=args.model, providers=['CPUExecutionProvider'])
        app.prepare(ctx_id=0, det_size=(640, 640))
        print("✅ Face recognition model loaded successfully")
    except Exception as e:
        print(f"❌ Failed to load model: {e}")
        sys.exit(1)

    # استخراج الـ Embeddings
    results = extract_embeddings_from_images(images_data, app)

    # حفظ النتائج
    output_data = {
        'metadata': {
            'total_images': len(images_data),
            'processed_images': len(results),
            'total_faces': sum(r['face_count'] for r in results),
            'created_at': datetime.now().isoformat(),
            'model': args.model,
            'threshold': args.threshold
        },
        'images': results
    }

    # حفظ الملف
    output_path = Path(EMBEDDINGS_FILE)
    output_path.parent.mkdir(exist_ok=True)
    
    with open(output_path, 'w') as f:
        json.dump(output_data, f, indent=2)

    print("\n" + "=" * 60)
    print(f"✅ Embeddings saved to: {output_path}")
    print(f"📊 Processed: {len(results)} images with {sum(r['face_count'] for r in results)} faces")
    print("=" * 60)

if __name__ == '__main__':
    main()
