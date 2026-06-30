#!/usr/bin/env python3
import os
import sys
import json
import numpy as np
from pathlib import Path
from scipy.spatial.distance import cosine

EMBEDDINGS_FILE = 'embeddings/gallery_embeddings.json'

def cosine_similarity(a, b):
    return 1 - cosine(a, b)

def find_matching_faces(query_embedding, gallery_data, threshold=0.6):
    matches = []
    
    for image_data in gallery_data.get('images', []):
        best_score = 0
        best_face = None
        
        for face_data in image_data.get('faces', []):
            gallery_embedding = np.array(face_data['embedding'])
            similarity = cosine_similarity(query_embedding, gallery_embedding)
            
            if similarity > best_score:
                best_score = similarity
                best_face = face_data
        
        if best_score >= threshold:
            matches.append({
                'image_id': image_data['image_id'],
                'url': image_data['url'],
                'public_id': image_data.get('public_id', ''),
                'title': image_data.get('title', ''),
                'similarity': float(best_score),
                'face_count': image_data.get('face_count', 0)
            })
    
    matches.sort(key=lambda x: x['similarity'], reverse=True)
    return matches

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--input', type=str, help='JSON file with query embedding')
    parser.add_argument('--threshold', type=float, default=0.6)
    args = parser.parse_args()

    if args.input:
        with open(args.input, 'r') as f:
            query_data = json.load(f)
    else:
        input_data = sys.stdin.read()
        if not input_data:
            print("❌ No input data provided")
            sys.exit(1)
        query_data = json.loads(input_data)

    if not os.path.exists(EMBEDDINGS_FILE):
        print(f"❌ Embeddings file not found: {EMBEDDINGS_FILE}")
        print("Please run extract_embeddings.py first")
        sys.exit(1)

    with open(EMBEDDINGS_FILE, 'r') as f:
        gallery_data = json.load(f)

    query_embedding = np.array(query_data['embedding'])
    threshold = query_data.get('threshold', args.threshold)
    
    matches = find_matching_faces(query_embedding, gallery_data, threshold)

    result = {
        'matches': matches,
        'total_matches': len(matches),
        'threshold_used': threshold
    }
    
    print(json.dumps(result))

if __name__ == '__main__':
    main()
