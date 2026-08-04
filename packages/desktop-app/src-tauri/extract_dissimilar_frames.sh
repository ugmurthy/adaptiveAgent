#!/bin/bash
#===============================================================================
# extract_dissimilar_frames.sh
# 
# Production script for extracting visually dissimilar frames from videos.
# Combines scene detection, keyframe extraction, and deduplication.
#
# Usage: ./extract_dissimilar_frames.sh <input_video> [options]
#===============================================================================

set -e

VERSION="1.0.0"

#-------------------------------------------------------------------------------
# Configuration Defaults
#-------------------------------------------------------------------------------
SCENE_THRESHOLD=${SCENE_THRESHOLD:-0.3}
OUTPUT_FORMAT=${OUTPUT_FORMAT:-png}
QUALITY=${QUALITY:-2}  # PNG compression or JPEG quality
USE_GPU=${USE_GPU:-false}

#-------------------------------------------------------------------------------
# Helper Functions
#-------------------------------------------------------------------------------
log() {
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*"
}

error_exit() {
    log "ERROR: $*" >&2
    exit 1
}

check_ffmpeg() {
    if ! command -v ffmpeg &>/dev/null; then
        error_exit "ffmpeg is not installed. Install it first."
    fi
    log "Using $(ffmpeg -version | head -n1)"
}

check_input() {
    local file="$1"
    if [[ ! -f "$file" ]]; then
        error_exit "Input file not found: $file"
    fi
    local duration=$(ffprobe -v error -show_entries format=duration \
        -of default=noprint_wrappers=1:nokey=1 "$file" 2>/dev/null)
    log "Duration: ${duration}s"
    
    local size=$(stat -f%z "$file" 2>/dev/null || stat -c%s "$file" 2>/dev/null)
    log "File size: $(numfmt --to=iec-i --suffix=B $size 2>/dev/null || echo "${size} bytes")"
}

#-------------------------------------------------------------------------------
# Core Extraction Methods
#-------------------------------------------------------------------------------

# Method 1: Scene Detection (primary method)
scene_detection_extract() {
    local input="$1"
    local output_dir="$2"
    local threshold="${3:-$SCENE_THRESHOLD}"
    
    log "Scene detection with threshold=$threshold"
    
    if [[ "$USE_GPU" == "true" && $(ffmpeg -encoders 2>&1 | grep -q "h264_nvenc"; echo $?) -eq 0 ]]; then
        ffmpeg -y -gpu any -i "$input" \
            -vf "select='gt(scene,$threshold)'" \
            -vsync vfr \
            "${output_dir}/scene_%04d.$OUTPUT_FORMAT" 2>/dev/null || true
    else
        ffmpeg -y -i "$input" \
            -vf "select='gt(scene,$threshold)'" \
            -vsync vfr \
            "${output_dir}/scene_%04d.$OUTPUT_FORMAT" 2>/dev/null || true
    fi
    
    ls -1 "${output_dir}/scene_"*".${OUTPUT_FORMAT}" 2>/dev/null | wc -l | xargs -I{} log "Extracted {} scene-change frames"
}

# Method 2: Keyframe (I-frame) Extraction
keyframe_extract() {
    local input="$1"
    local output_dir="$2"
    
    log "Extracting keyframes (I-frames)"
    
    ffmpeg -y -i "$input" \
        -vf "select='eq(pict_type,I)'" \
        -vsync vfr \
        "${output_dir}/keyframe_%04d.$OUTPUT_FORMAT" 2>/dev/null || true
    
    local count=$(ls -1 "${output_dir}/keyframe_"*".${OUTPUT_FORMAT}" 2>/dev/null | wc -l)
    log "Extracted $count keyframes"
}

# Method 3: Periodic Sampling (fallback/supplemental)
periodic_sample() {
    local input="$1"
    local output_dir="$2"
    local fps="${3:-0.5}"  # Sample every 2 seconds by default
    
    log "Periodic sampling at ${fps} FPS"
    
    local duration=$(ffprobe -v error -show_entries format=duration \
        -of default=noprint_wrappers=1:nokey=1 "$input")
    local total_frames=$(echo "$duration * $fps" | bc | cut -d. -f1)
    total_frames=${total_frames:-10}
    
    ffmpeg -y -i "$input" \
        -vf "select='not(mod(n,$(echo "scale=0;1/$fps" | bc))'),setsar=1" \
        -vsync vfr \
        "${output_dir}/periodic_%04d.$OUTPUT_FORMAT" 2>/dev/null || true
    
    local count=$(ls -1 "${output_dir}/periodic_"*".${OUTPUT_FORMAT}" 2>/dev/null | wc -l)
    log "Extracted $count periodic samples"
}

# Method 4: Motion Threshold Detection
motion_threshold_detect() {
    local input="$1"
    local output_dir="$2"
    local motion_threshold="${3:-0.2}"
    
    log "Motion-based detection (threshold=$motion_threshold)"
    
    # Use a lower threshold to catch subtle movements
    ffmpeg -y -i "$input" \
        -vf "select='gt(scene,$motion_threshold)'" \
        -vsync vfr \
        "${output_dir}/motion_%04d.$OUTPUT_FORMAT" 2>/dev/null || true
    
    local count=$(ls -1 "${output_dir}/motion_"*".${OUTPUT_FORMAT}" 2>/dev/null | wc -l)
    log "Extracted $count motion-detect frames"
}

#-------------------------------------------------------------------------------
# Post-Processing
#-------------------------------------------------------------------------------

deduplicate_frames() {
    local output_dir="$1"
    local similarity_threshold="${2:-85}"  # Percent similarity to consider duplicate
    
    log "Deduplicating frames..."
    
    python3 << DEDUP_SCRIPT
import os
from PIL import Image
import numpy as np
import shutil

output_dir = '${output_dir}'
similarity_threshold = ${similarity_threshold}

def calculate_similarity(img1_path, img2_path):
    """Calculate percentage similarity between two images"""
    try:
        img1 = Image.open(img1_path).resize((160, 90)).convert('RGB')
        img2 = Image.open(img2_path).resize((160, 90)).convert('RGB')
        
        arr1 = np.array(img1).astype(float)
        arr2 = np.array(img2).astype(float)
        
        mse = np.mean((arr1 - arr2) ** 2)
        if mse == 0:
            return 100
        
        max_val = np.max(arr1) - np.min(arr1)
        if max_val == 0:
            max_val = 1
            
        ssim = ((np.max(arr1) + np.max(arr2))**2 + (np.std(arr1) + np.std(arr2))**2) / \
               ((np.max(arr1) + np.max(arr2))**2 + (np.std(arr1) + np.std(arr2))**2 + mse/max_val)
               
        return float(ssim * 100)
    except Exception as e:
        return 0

# Collect all extracted frames
all_frames = []
for f in sorted(os.listdir(output_dir)):
    if f.endswith('.png') or f.endswith('.jpg'):
        path = os.path.join(output_dir, f)
        # Determine priority based on filename prefix
        if f.startswith('scene_'):
            priority = 1
        elif f.startswith('keyframe_'):
            priority = 2
        elif f.startswith('motion_'):
            priority = 3
        elif f.startswith('periodic_'):
            priority = 4
        else:
            priority = 99
        all_frames.append((priority, f, path))

all_frames.sort(key=lambda x: x[0])

# Deduplicate while preserving highest-priority frames
kept_frames = []
removed_count = 0

for priority, fname, fpath in all_frames:
    is_duplicate = False
    for kept_priority, kept_fname, kept_fpath in kept_frames:
        sim = calculate_similarity(fpath, kept_fpath)
        if sim > similarity_threshold:
            is_duplicate = True
            break
    
    if not is_duplicate:
        # Keep this frame
        final_name = f'final_{len(kept_frames):04d}.png'
        shutil.copy(fpath, os.path.join(output_dir, final_name))
        kept_frames.append((priority, final_name, os.path.join(output_dir, final_name)))
    else:
        removed_count += 1

# Remove original intermediate files
for _, fname, _ in all_frames:
    fpath = os.path.join(output_dir, fname)
    if os.path.exists(fpath) and not fname.startswith('final_'):
        os.remove(fpath)

print(f'Kept {len(kept_frames)} unique frames, removed {removed_count} duplicates')
DEDUP_SCRIPT
    
    log "Deduplication complete"
}

resize_frames() {
    local output_dir="$1"
    local width="${2:-1920}"
    local height="${3:-1080}"
    
    log "Resizing frames to ${width}x${height}..."
    
    local count=$(find "$output_dir" -maxdepth 1 -name 'final_*.png' | wc -l)
    
    if [[ $count -gt 0 ]]; then
        find "$output_dir" -maxdepth 1 -name 'final_*.png' | \
        parallel -j 4 ffmpeg -y -i {} -vf "scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:color=black" {}.tmp && \
        for f in "$output_dir"/final_*.png.tmp; do mv "$f" "${f%.tmp}"; done
    fi
    
    log "Resize complete"
}

generate_thumbnail_grid() {
    local output_dir="$1"
    local grid_output="${2:-thumbnails.jpg}"
    
    log "Generating thumbnail grid: $grid_output"
    
    find "$output_dir" -maxdepth 1 -name 'final_*.png' -type f | sort | head -50 | \
    parallel -j 8 convert {} -gravity center -extent 160x90 "temp_thumb_#{}.jpg" 2>/dev/null || true
    
    if ls temp_thumb_*.jpg &>/dev/null; then
        montage -mode concatenate -tile 10x5 temp_thumb_*.jpg "$grid_output" 2>/dev/null && \
        rm -f temp_thumb_*.jpg && \
        log "Thumbnail grid created: $grid_output"
    fi
}

#-------------------------------------------------------------------------------
# Main Workflow
#-------------------------------------------------------------------------------

run_extraction() {
    local input_file="$1"
    local method="${2:-hybrid}"
    
    check_ffmpeg
    check_input "$input_file"
    
    mkdir -p "$OUTPUT_DIR"
    
    case "$method" in
        scene)
            scene_detection_extract "$input_file" "$OUTPUT_DIR" "$SCENE_THRESHOLD"
            ;;
        keyframe)
            keyframe_extract "$input_file" "$OUTPUT_DIR"
            ;;
        motion)
            motion_threshold_detect "$input_file" "$OUTPUT_DIR"
            ;;
        periodic)
            periodic_sample "$input_file" "$OUTPUT_DIR"
            ;;
        hybrid)
            log "Running hybrid extraction (scene + keyframe)..."
            scene_detection_extract "$input_file" "$OUTPUT_DIR" "$SCENE_THRESHOLD"
            keyframe_extract "$input_file" "$OUTPUT_DIR"
            deduplicate_frames "$OUTPUT_DIR"
            ;;
        all)
            log "Running ALL extraction methods..."
            scene_detection_extract "$input_file" "$OUTPUT_DIR" "$SCENE_THRESHOLD"
            keyframe_extract "$input_file" "$OUTPUT_DIR"
            motion_threshold_detect "$input_file" "$OUTPUT_DIR"
            periodic_sample "$input_file" "$OUTPUT_DIR"
            deduplicate_frames "$OUTPUT_DIR"
            ;;
        *)
            error_exit "Unknown method: $method. Use: scene, keyframe, motion, periodic, hybrid, or all"
            ;;
    esac
    
    log "Extraction complete. Output directory: $(realpath $OUTPUT_DIR)"
    ls -la "$OUTPUT_DIR"
}

#-------------------------------------------------------------------------------
# CLI Interface
#-------------------------------------------------------------------------------

show_help() {
    cat << EOF
extract_dissimilar_frames.sh v${VERSION}

Usage: $0 <input_video> [OPTIONS]

Required:
  input_video          Path to the input video file

Options:
  -m, --method <name>  Extraction method (default: hybrid)
                       Valid values: scene, keyframe, motion, periodic, hybrid, all
  -t, --threshold <n>  Scene detection threshold 0.1-1.0 (default: 0.3)
  -o, --output <dir>   Output directory (default: extracted_frames)
  -q, --quality <n>    Image quality/compression level (default: 2)
  -r, --resize <wxh>   Resize output frames (e.g., "1920x1080")
  -g, --gpu            Use GPU acceleration if available
  -h, --help           Show this help message

Examples:
  $0 video.mp4
  $0 video.mp4 -m scene -t 0.2
  $0 video.mp4 -m all -o my_frames -r 1280x720
  $0 video.mp4 -m hybrid --gpu

EOF
}

#-------------------------------------------------------------------------------
# Argument Parsing
#-------------------------------------------------------------------------------

METHOD="hybrid"
INPUT_FILE=""
MAX_FRAMES=""

while [[ $# -gt 0 ]]; do
    case "$1" in
        -m|--method)
            METHOD="$2"
            shift 2
            ;;
        -t|--threshold)
            SCENE_THRESHOLD="$2"
            shift 2
            ;;
        -o|--output)
            OUTPUT_DIR="$2"
            shift 2
            ;;
        -q|--quality)
            QUALITY="$2"
            shift 2
            ;;
        -r|--resize)
            RESIZE_DIMS="$2"
            shift 2
            ;;
        -g|--gpu)
            USE_GPU=true
            shift
            ;;
        -h|--help)
            show_help
            exit 0
            ;;
        -*)
            error_exit "Unknown option: $1"
            ;;
        *)
            INPUT_FILE="$1"
            shift
            ;;
    esac
done

if [[ -z "$INPUT_FILE" ]]; then
    show_help
    error_exit "No input video specified"
fi

#-------------------------------------------------------------------------------
# Execute
#-------------------------------------------------------------------------------

run_extraction "$INPUT_FILE" "$METHOD"

exit 0
