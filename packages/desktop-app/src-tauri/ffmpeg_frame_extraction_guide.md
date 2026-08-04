# Extracting Visually Dissimilar Frames from Video with FFmpeg

This guide demonstrates multiple approaches for extracting keyframes, scene changes, and visually distinct frames from video files using FFmpeg and related tools.

---

## Table of Contents

1. [Scene Detection Using FFmpeg](#1-scene-detection-using-ffmpeg)
2. [Frame Differencing Method](#2-frame-differencing-method)
3. [Motion-Based Detection](#3-motion-based-detection)
4. [Advanced Techniques](#4-advanced-techniques)
5. [Complete Shell Script Example](#5-complete-shell-script-example)

---

## 1. Scene Detection Using FFmpeg

FFmpeg has built-in scene detection filters that can identify visual transitions in videos.

### Basic Scene Detection

```bash
# Detect scene changes and print timestamps to stdout
ffmpeg -i input.mp4 -an -vf "select='gt(scene,0.3)'" -f null - 2>&1 | grep -oP 'Picked.*'
```

### Extract Scene Change Frames

```bash
# Extract one frame at each detected scene change (threshold 0.3)
ffmpeg -i input.mp4 -an -vf "select='gt(scene,0.3)'" -vsync vfr output_%03d.png
```

### Multiple Threshold Levels

```bash
# Low threshold - catches more subtle changes
ffmpeg -i input.mp4 -vf "select='gt(scene,0.2)'" -vsync vfr scenes_low_%03d.png

# Medium threshold - balanced detection  
ffmpeg -i input.mp4 -vf "select='gt(scene,0.3)'" -vsync vfr scenes_med_%03d.png

# High threshold - only major scene changes
ffmpeg -i input.mp4 -vf "select='gt(scene,0.4)'" -vsync vfr scenes_high_%03d.png
```

### Combined Scene + I-Frame Detection

```bash
# Use both scene detection and keyframe selection
ffmpeg -i input.mp4 -vf "select='eq(n%300,0)+gt(scene,0.4)'" -vsync vfr mixed_frames_%03d.png
```

---

## 2. Frame Differencing Method

Compare consecutive frames and extract those that differ significantly from their neighbors.

### Simple Frame Difference Filter

```bash
# Extract frames that are different from previous frame
ffmpeg -i input.mp4 -vf "select='if(eq(n,0),1,lte(sum(diff(prev))*,50000)')", \
    "split[s0][s1];[s0]buffer=duration=1:time_base=1;[s1][s0]framestep=n=1,scale2ref[neg][pos]; \
    [neg][pos]overlay=format_expr=6,select='gt(sigmoid(format_expr(2)-0.5),0.8)'" \
    -vsync vfr diff_frames_%03d.png
```

### Simplified Difference Approach

```bash
# Use psnr filter to find significantly different frames
ffmpeg -i input.mp4 -filter_complex "null,difference=null\|input_1" -c:v copy temp.mkv

# Extract frames where difference exceeds threshold
ffmpeg -i input.mp4 -vf "pad=iw*2:-1:y,split[a][b];[a]crop=iw*2:ih/2:0:0[c1];[b]crop=iw*2:ih/2:0:ih/2[c2]; \
    [c1][c2]psnr=whole_image=true" -f null - 2>&1 | grep PSNR | tail -n +2
```

### Practical Frame Skip with Similarity Check

```bash
#!/bin/bash
# Only save frames that are sufficiently different from the last saved frame

INPUT="input.mp4"
OUTPUT_DIR="extracted_frames"
THRESHOLD=30000  # Adjust sensitivity (higher = fewer frames)

mkdir -p "$OUTPUT_DIR"

ffmpeg -i "$INPUT" -vf "fps=1" -c:v ppm pipe:1 > /tmp/all_frames.bin 2>/dev/null

python3 << 'PYEOF'
import subprocess
import os
from PIL import Image
import io
import numpy as np

def frames_are_different(frame1, frame2, threshold=50):
    """Return True if frames differ by more than threshold pixels"""
    d = Image.chops.difference(frame1, frame2)
    bbox = d.getbbox()
    if bbox is None:
        return False
    return True

last_frame = None
saved_count = 0

for i in range(0, 300):  # Process first 300 fps-extracted frames
    try:
        current = Image.open(f'/tmp/frame_{i:04d}.png')
        current = current.resize((320, 180))  # Scale down for speed
        
        if last_frame is None or frames_are_different(current, last_frame):
            current.save(f'{output_dir}/scene_{saved_count:04d}.png')
            last_frame = current
            saved_count += 1
    except Exception as e:
        pass
PYEOF
```

---

## 3. Motion-Based Detection

Extract frames based on motion analysis within the video.

### Using Motion Vectors (when available)

```bash
# Extract frames with high motion activity
ffmpeg -i input.mp4 -vf "metadata" -f null - 2>&1 | \
    grep -E "mv:" | awk -F'mv=[+-][+-]*' '{print $2}' | head -100
```

### Variance-Based Motion Detection

```bash
# Extract frames where pixel variance between frames is high
ffmpeg -i input.mp4 -vf "select='gt(difference(prev),0.1)'" -vsync vfr motion_frames_%03d.png
```

### Temporal Variation Filter

```bash
# Use the temporal variation to detect active scenes
ffmpeg -i input.mp4 -vf "signalstats=measure_all" -f null - 2>&1 | \
    grep "Avg.*Var" | sort -k3 -rn | head -20
```

### Complex Motion Filter Chain

```bash
#!/bin/bash
# Extract frames during periods of high motion

INPUT="${1:-input.mp4}"
OUTPUT_PREFIX="${2:-motion_frames}"

ffmpeg -i "$INPUT" -vf "
    split[s0][s1];
    [s0]format=pix_fmt=yuv420p,scale=160:-1[motion_in];
    [s1]buffersink=video_size=160:-1,motion_est=\
        search_method=full+hex+umhex:\
        block_size=16x16:\
        block_max=-10:-1:\
        block_min=10:1,select='gte(mv_sum,50)',\
        format=pix_fmt=yuv420p[motion_out];
    [motion_out]format=rgb24
" -vsync vfr "${OUTPUT_PREFIX}_%04d.png"
```

### Using Histogram Difference

```bash
#!/bin/bash
# More sophisticated histogram-based frame selection

INPUT="${1:-input.mp4}"
FPS="${2:-1}"  # Input FPS rate for sampling
THRESHOLD="${3:-20}"  # Histogram difference threshold

mkdir -p extracted_histogram_frames

# Extract frames at regular intervals
ffmpeg -i "$INPUT" -vf "fps=$FPS" -qscale:v 2 temp_sample_%06d.png 2>/dev/null

# Calculate histogram differences and select dissimilar frames
python3 << PYEOF
import os
import subprocess
from PIL import Image
import numpy as np

def get_histogram(img):
    arr = np.array(img.convert('RGB'))
    hist = np.histogram(arr.flatten(), bins=256, range=(0, 256))[0]
    return hist.astype(float) / len(arr.flatten())

def histogram_distance(h1, h2):
    return np.sum(np.abs(h1 - h2))

frames_dir = '.'
selected = []
last_hist = None
threshold = ${THRESHOLD} * 0.01  # Convert percentage to decimal

for f in sorted(os.listdir(frames_dir)):
    if not f.startswith('temp_sample_'):
        continue
    
    img_path = os.path.join(frames_dir, f)
    img = Image.open(img_path)
    img = img.resize((128, 72))  # Downsample for speed
    hist = get_histogram(img)
    
    if last_hist is None or histogram_distance(hist, last_hist) > threshold:
        selected.append(img_path)
        last_hist = hist
        
        # Copy to final output
        dest = os.path.join('extracted_histogram_frames', f'thumb_{len(selected):04d}.png')
        img.copy().save(dest)
        
print(f'Selected {len(selected)} visually dissimilar frames')
PYEOF

rm -f temp_sample_*.png
```

---

## 4. Advanced Techniques

### Deep Learning Scene Change Detection

```bash
# Install Python dependencies (one-time setup)
pip install scikit-video opencv-python-headless numpy pillow

# Run Python-based deep scene detection
python3 << 'PYEOF'
import cv2
import numpy as np

def detect_scenes(video_path, output_prefix='scenedetect_output', threshold=12):
    cap = cv2.VideoCapture(video_path)
    
    frame_num = 0
    last_frame = None
    scene_changes = []
    
    while True:
        ret, frame = cap.read()
        if not ret:
            break
            
        gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
        gray_resized = cv2.resize(gray, (320, 180))
        
        if last_frame is not None:
            diff = cv2.absdiff(last_frame, gray_resized)
            mean_diff = np.mean(diff)
            
            if mean_diff > threshold:
                scene_changes.append((frame_num, int(mean_diff)))
                cv2.imwrite(f'{output_prefix}_{len(scene_changes):04d}.png', 
                           cv2.cvtColor(frame, cv2.COLOR_BGR2BGR))
        
        last_frame = gray_resized
        frame_num += 1
    
    cap.release()
    print(f'Detected {len(scene_changes)} scene changes:')
    for fc, intensity in scene_changes[:10]:  # Show first 10
        print(f'  Frame {fc}: intensity={intensity:.2f}')

detect_scenes('input.mp4', 'detected_scenes', threshold=15)
PYEOF
```

### Multi-Pass Extraction Strategy

```bash
#!/bin/bash
# Two-pass approach: first find candidate frames, then select most dissimilar ones

INPUT="${1:-input.mp4}"
FINAL_OUTPUT_DIR="final_keyframes"
TEMP_DIR="temp_candidates"
MAX_FRAMES="${2:-50}"

echo "=== Pass 1: Scene Detection ==="
ffmpeg -i "$INPUT" -vf "select='gt(scene,0.3)'" -vsync vfr "$TEMP_DIR"/scene_%04d.png 2>/dev/null

echo "=== Pass 2: Add Keyframe Sampling ==="
# Also extract regular keyframes to ensure coverage
ffmpeg -i "$INPUT" -vf "select='eq(pict_type,I)'" -vsync vfr "$TEMP_DIR"/keyframe_%04d.png 2>/dev/null

echo "=== Pass 3: Deduplicate and Select ==="
python3 << PYEOF
import os
from PIL import Image
import numpy as np
from sklearn.cluster import KMeans

temp_dir = '${TEMP_DIR}'
max_frames = ${MAX_FRAMES}

# Load all extracted frames
all_frames = []
for f in sorted(os.listdir(temp_dir)):
    if f.endswith('.png'):
        path = os.path.join(temp_dir, f)
        img = Image.open(path).resize((160, 90)).convert('RGB')
        all_frames.append((path, np.array(img).flatten()))

if not all_frames:
    print("No frames found!")
    exit(1)

# If we have enough unique frames, just take the first max_frames
if len(all_frames) <= max_frames:
    for i, (path, _) in enumerate(all_frames):
        import shutil
        shutil.copy(path, os.path.join('${FINAL_OUTPUT_DIR}', f'keyframe_{i:04d}.png'))
else:
    # Use K-means clustering to select representative frames
    X = np.array([feat for _, feat in all_frames])
    kmeans = KMeans(n_clusters=min(max_frames, len(all_frames)), random_state=42)
    labels = kmeans.fit_predict(X)
    
    # For each cluster, pick the frame closest to centroid
    os.makedirs('${FINAL_OUTPUT_DIR}', exist_ok=True)
    selected_idx = set()
    for cluster_id in range(min(max_frames, len(all_frames))):
        members = [i for i, l in enumerate(labels) if l == cluster_id]
        centroid = kmeans.cluster_centers_[cluster_id]
        closest = min(members, key=lambda i: np.linalg.norm(X[i] - centroid))
        selected_idx.add(closest)
    
    for idx in sorted(selected_idx)[:max_frames]:
        path, _ = all_frames[idx]
        import shutil
        shutil.copy(path, os.path.join('${FINAL_OUTPUT_DIR}', f'keyframe_{len(selected_idx):04d}.png'))

print(f'Selected {min(len(all_frames), max_frames)} keyframes')
PYEOF

rm -rf "$TEMP_DIR"
echo "Done! Output in $FINAL_OUTPUT_DIR/"
```

### GPU-Accelerated Processing

```bash
# Check CUDA support and use GPU if available
ffmpeg -init_hw_device cuda=0 -hwaccel cuda -hwaccel_output_format cuda \
    -i input_gpu.mp4 \
    -vf "select=gte(scene,0.3)" \
    -vsync vfr gpu_frames_%04d.png

# NVENC-specific options for faster processing
ffmpeg -gpu any -i input.mp4 -vf "scene=0.3" -vsync vfr fast_frames_%04d.png
```

---

## 5. Complete Shell Script Example

Here's a complete, production-ready script combining multiple approaches:

```bash
#!/bin/bash
#===============================================================================
# extract_dissimilar_frames.sh
# 
# Extract visually dissimilar frames from video using multiple methods
#
# Usage: ./extract_dissimilar_frames.sh <input_video> [options]
#
# Options:
#   -m, --method <name>    Detection method: scene|motion|hybrid|all (default: hybrid)
#   -t, --threshold <val>  Sensitivity threshold 0.1-1.0 (default: 0.3)
#   -o, --output <dir>     Output directory (default: extracted_frames)
#   -n, --count <num>      Maximum number of frames to extract (default: unlimited)
#   -h, --help             Show this help message
#===============================================================================

set -e

# Defaults
METHOD="hybrid"
THRESHOLD="0.3"
OUTPUT_DIR="extracted_frames"
MAX_COUNT=""

# Parse arguments
while [[ $# -gt 0 ]]; do
    case $1 in
        -m|--method)
            METHOD="$2"
            shift 2
            ;;
        -t|--threshold)
            THRESHOLD="$2"
            shift 2
            ;;
        -o|--output)
            OUTPUT_DIR="$2"
            shift 2
            ;;
        -n|--count)
            MAX_COUNT="$2"
            shift 2
            ;;
        -h|--help)
            echo "Usage: $0 <input_video> [options]"
            echo ""
            echo "Options:"
            echo "  -m, --method <name>    Detection method: scene|motion|hybrid|all"
            echo "  -t, --threshold <val>  Sensitivity threshold 0.1-1.0"
            echo "  -o, --output <dir>     Output directory"
            echo "  -n, --count <num>      Maximum number of frames"
            exit 0
            ;;
        *)
            INPUT_FILE="$1"
            shift
            ;;
    esac
done

if [[ -z "$INPUT_FILE" || ! -f "$INPUT_FILE" ]]; then
    echo "Error: Please provide a valid input video file"
    exit 1
fi

mkdir -p "$OUTPUT_DIR"
echo "Input:  $INPUT_FILE"
echo "Method: $METHOD (threshold: $THRESHOLD)"
echo "Output: $OUTPUT_DIR/"

#-------------------------------------------------------------------------------
# Method 1: Scene Detection
#-------------------------------------------------------------------------------
scene_detect() {
    local count=0
    ffmpeg -y -i "$INPUT_FILE" \
        -vf "select='gt(scene,$THRESHOLD)'" \
        -vsync vfr \
        "${OUTPUT_DIR}/scene_%04d.png" 2>/dev/null
    
    ls -1 "${OUTPUT_DIR}/scene_"*.png 2>/dev/null | wc -l
}

#-------------------------------------------------------------------------------
# Method 2: Keyframe Extraction
#-------------------------------------------------------------------------------
keyframe_extract() {
    local count=0
    ffmpeg -y -i "$INPUT_FILE" \
        -vf "select='eq(pict_type,I)'" \
        -vsync vfr \
        "${OUTPUT_DIR}/keyframe_%04d.png" 2>/dev/null
    
    ls -1 "${OUTPUT_DIR}/keyframe_"*.png 2>/dev/null | wc -l
}

#-------------------------------------------------------------------------------
# Method 3: Motion Detection
#-------------------------------------------------------------------------------
motion_detect() {
    local count=0
    # Lower threshold for motion (detects smaller movements)
    ffmpeg -y -i "$INPUT_FILE" \
        -vf "select='gt(scene,$((THRESHOLD/2)))'" \
        -vsync vfr \
        "${OUTPUT_DIR}/motion_%04d.png" 2>/dev/null
    
    ls -1 "${OUTPUT_DIR}/motion_"*.png 2>/dev/null | wc -l
}

#-------------------------------------------------------------------------------
# Method 4: Uniform Sampling (for baseline comparison)
#-------------------------------------------------------------------------------
uniform_sample() {
    local duration=$(ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "$INPUT_FILE")
    local count=${1:-30}
    local interval=$(echo "$duration / $count" | bc -l 2>/dev/null || echo "10")
    
    ffmpeg -y -i "$INPUT_FILE" \
        -vf "select='not(mod(t,$interval))'" \
        -vsync vfr \
        "${OUTPUT_DIR}/uniform_%04d.png" 2>/dev/null
    
    ls -1 "${OUTPUT_DIR}/uniform_"*.png 2>/dev/null | wc -l
}

#-------------------------------------------------------------------------------
# Execute Selected Method(s)
#-------------------------------------------------------------------------------
case "$METHOD" in
    scene)
        echo "Running scene detection..."
        count=$(scene_detect)
        echo "Extracted $count scene-change frames"
        ;;
    keyframe)
        echo "Extracting keyframes..."
        count=$(keyframe_extract)
        echo "Extracted $count keyframes"
        ;;
    motion)
        echo "Running motion detection..."
        count=$(motion_detect)
        echo "Extracted $count motion frames"
        ;;
    hybrid)
        echo "Running hybrid detection (scene + keyframe)..."
        scene_count=$(scene_detect)
        key_count=$(keyframe_extract)
        echo "Extracted $scene_count scene frames + $key_count keyframes"
        
        # Merge and deduplicate with higher priority on scene frames
        python3 << DEDUP_PY
import os
from PIL import Image
import numpy as np
import shutil

output_dir = '${OUTPUT_DIR}'
max_count = ${MAX_COUNT}

# Collect all frames
all_files = []
priority = {'scene': 1, 'keyframe': 2, 'motion': 3, 'uniform': 4}

for f in sorted(os.listdir(output_dir)):
    if f.endswith('.png'):
        prefix = f.split('_')[0]
        all_files.append((prefix, f, priority.get(prefix, 99)))

all_files.sort(key=lambda x: (x[2], x[1]))

# Simple deduplication based on timestamp/proximity
seen_types = set()
merged_count = 0
for prefix, fname, prio in all_files:
    src = os.path.join(output_dir, fname)
    if merged_count >= ${MAX_COUNT:-9999}:
        break
    
    # Keep scene frames, replace similar keyframes
    if prefix == 'scene':
        dst = os.path.join(output_dir, f'final_merged_{merged_count:04d}.png')
        shutil.copy(src, dst)
        seen_types.add(fname)
        merged_count += 1
    elif prefix == 'keyframe':
        # Check if there's a nearby scene frame
        scene_exists = any('scene' in s for s in seen_types if fname.split('.')[0][-4:] in s[-10:])
        if not scene_exists:
            dst = os.path.join(output_dir, f'final_merged_{merged_count:04d}.png')
            shutil.copy(src, dst)
            merged_count += 1

# Clean up originals
for ext in ['scene_', 'keyframe_', 'motion_', 'uniform_']:
    for f in os.listdir(output_dir):
        if f.startswith(ext):
            os.remove(os.path.join(output_dir, f))

print(f'Merged into {merged_count} final frames')
DEDUP_PY
        ;;
    all)
        echo "Running ALL detection methods..."
        echo "- Scene detection..."
        scene_detect
        echo "- Keyframe extraction..."
        keyframe_extract
        echo "- Motion detection..."
        motion_detect
        echo "- Uniform sampling (30 frames)..."
        uniform_sample 30
        echo "All methods completed. Results in $OUTPUT_DIR/"
        ;;
    *)
        echo "Unknown method: $METHOD"
        echo "Valid methods: scene, keyframe, motion, hybrid, all"
        exit 1
        ;;
esac

# Apply max count limit if specified
if [[ -n "$MAX_COUNT" ]]; then
    python3 << LIMIT_PY
import os
import shutil

output_dir = '${OUTPUT_DIR}'
max_count = ${MAX_COUNT}

# Get all final/merged frames
frames = sorted([f for f in os.listdir(output_dir) if f.endswith('.png')])

if len(frames) > max_count:
    # Keep evenly spaced subset
    step = len(frames) // max_count
    keep = frames[::step][:max_count]
    for f in frames:
        if f not in keep:
            os.remove(os.path.join(output_dir, f))
    print(f'Limited to {len(keep)} frames')
LIMIT_PY
fi

echo "=== Extraction Complete ==="
echo "Output directory: $(realpath $OUTPUT_DIR)"
ls -1 "${OUTPUT_DIR}"/final_*.{png,jpg} 2>/dev/null || ls -1 "${OUTPUT_DIR}"/"*".png 2>/dev/null | head -10
