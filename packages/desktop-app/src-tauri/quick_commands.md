# Quick Reference: FFmpeg Commands for Dissimilar Frame Extraction

## One-Liner Commands

### Basic Scene Detection
```bash
# Extract scene changes with default threshold
ffmpeg -i video.mp4 -vf "select='gt(scene,0.3)'" -vsync vfr frames_%03d.png

# High sensitivity (catches subtle changes)
ffmpeg -i video.mp4 -vf "select='gt(scene,0.2)'" -vsync vfr sensitive_%03d.png

# Low sensitivity (only major scenes)
ffmpeg -i video.mp4 -vf "select='gt(scene,0.4)'" -vsync vfr major_%03d.png
```

### Keyframe Extraction
```bash
# Extract only I-frames (keyframes)
ffmpeg -i video.mp4 -vf "select='eq(pict_type,I)'" -vsync vfr keyframes_%03d.png
```

### Periodic Sampling
```bash
# Sample one frame every 5 seconds
ffmpeg -i video.mp4 -vf "select='not(mod(t,5))'" -vsync vfr samples_%03d.png

# Sample at 0.5 FPS (one per 2 seconds)
ffmpeg -i video.mp4 -vf "fps=0.5" -qscale:v 2 periodic_%03d.png
```

### Combined Methods
```bash
# Scene changes OR every 30th frame (backup coverage)
ffmpeg -i video.mp4 -vf "select='gt(scene,0.3)+mod(n,300)'" -vsync vfr hybrid_%03d.png

# Keyframes + high-motion scenes
ffmpeg -i video.mp4 -vf "select='eq(pict_type,I)+gt(scene,0.4)'" -vsync vfr mixed_%03d.png
```

## Common Use Cases

### Thumbnail Generation
```bash
# Generate 50 evenly-spaced thumbnails
ffmpeg -i input.mp4 -vf "fps=1/$(ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 input.mp4)/50" thumb_%02d.jpg

# Generate scene-change thumbnails resized to 640x360
ffmpeg -i input.mp4 -vf "select='gt(scene,0.3)',scale=640:360:force_original_aspect_ratio=decrease,pad=640:360:(ow-iw)/2:(oh-ih)/2:color=black" -vsync vfr thumbs_%03d.jpg
```

### Video Preview/GIF Creation
```bash
# Create preview MP4 from scene changes
ffmpeg -i input.mp4 -vf "select='gt(scene,0.3)',fps=1,scale=320:-1" -c:v libx264 -pix_fmt yuv420p preview.mp4

# Create animated GIF from first 30 unique frames
ffmpeg -i input.mp4 -vf "select='gt(scene,0.3)',scale=480:-1,fps=5,fifo" -frames:v 30 preview.gif
```

### Batch Processing
```bash
# Process all videos in a directory
for vid in *.mp4; do
    echo "Processing $vid..."
    ffmpeg -i "$vid" -vf "select='gt(scene,0.3)'" -vsync vfr "frames_${vid%.mp4}_%03d.png" 2>/dev/null
done

# With progress output
find . -name "*.mp4" -exec sh -c '
    video="$1"
    dir="$(dirname "$video")"
    base="$(basename "$video" .mp4)"
    mkdir -p "$dir/$base_frames"
    ffmpeg -i "$video" -vf "select='"'"'gt(scene,0.3)'"'"'" -vsync vfr "$dir/$base_frames/frame_%04d.png" -y 2>&1 | grep -v "Stream mapping\|Output \|#\|frame=" 
' _ {} \;
```

## Advanced Filters

### Using Motion Estimation
```bash
# Detect frames with significant motion vectors
ffmpeg -i video.mp4 -vf "mv=display=overlay+stats,movie='motion_stats.txt',select='gte(motion_sum,50)'" -vsync vfr motion_%03d.png
```

### Variance-Based Selection
```bash
# Select frames with high temporal variance
ffmpeg -i video.mp4 -vf "signalstats=measure_all,split[a][b];[a]buffer=duration=1:time_base=1/dt[sig];[b][sig]psnr,select='gt(variance_temporal,0.1)'" -vsync vfr variance_%03d.png
```

### Quality-Aware Extraction
```bash
# Extract frames from highest quality segments
ffmpeg -i video.mp4 -vf "qp,select='lt(q,30)'" -vsync vfr high_quality_%03d.png
```

## Performance Tips

### Faster Processing
```bash
# Skip decoding audio
ffmpeg -an -i video.mp4 -vf "select='gt(scene,0.3)'" -vsync vfr fast_%03d.png

# Use hardware acceleration (if available)
ffmpeg -hwaccel cuda -i video.mp4 -vf "select='gt(scene,0.3)'" -vsync vfr gpu_%03d.png

# Process at lower resolution for speed, then upscale if needed
ffmpeg -i video.mp4 -vf "scale=320:-1,select='gt(scene,0.3)'" -vsync vfr temp_%03d.png && \
parallel -j4 convert temp_*.png -resize 1920x1080 final_{}.png && rm temp_*.png
```

### Memory-Constrained Processing
```bash
# Limit thread usage
ffmpeg -threads 1 -i video.mp4 -vf "select='gt(scene,0.3)'" -vsync vfr limited_%03d.png

# Stream processing without temp files
ffmpeg -i video.mp4 -vf "select='gt(scene,0.3)'" -f image2 pipe:1 | tar czf extracted.tar.gz
```

## Output Format Options

### Different Image Formats
```bash
# PNG (lossless, larger files)
ffmpeg -i video.mp4 -vf "select='gt(scene,0.3)'" -vsync vfr png_frames/%04d.png

# JPEG (smaller files, adjustable quality)
ffmpeg -i video.mp4 -vf "select='gt(scene,0.3)'" -vsync vfr -q:v 2 jpg_frames/%04d.jpg

# WebP (modern format, good compression)
ffmpeg -i video.mp4 -vf "select='gt(scene,0.3)'" -vsync vfr webp_frames/%04d.webp

# PPM/PBM (for custom processing pipelines)
ffmpeg -i video.mp4 -vf "select='gt(scene,0.3)'" -vsync vfr ppm_frames/%04d.ppm
```

### Resolution Options
```bash
# Maintain aspect ratio with padding
ffmpeg -i video.mp4 -vf "select='gt(scene,0.3)',scale=iw:-1:flags=lanczos,pad=1920:1080:(ow-iw)/2:(oh-ih)/2:color=black" -vsync vfr padded_%03d.png

# Crop to square (center)
ffmpeg -i video.mp4 -vf "select='gt(scene,0.3)',crop=square" -vsync vfr square_%03d.png

# Letterbox for specific aspect ratios
ffmpeg -i video.mp4 -vf "select='gt(scene,0.3)',scale=1600:900:force_original_aspect_ratio=decrease,pad=1600:900:(ow-iw)/2:(oh-ih)/2:color=black" -vsync vfr wide_%03d.png
```

## Troubleshooting

### No Frames Extracted?
```bash
# Check video codec compatibility
ffprobe -v error -show_entries stream=codec_name,codec_type -of compact=p=0 input.mp4

# Try different thresholds
ffmpeg -i video.mp4 -vf "select='gt(scene,0.1)'" -vsync vfr test_%03d.png

# Force frame type detection
ffmpeg -i video.mp4 -vf "select='eq(pict_type,I)+eq(interlace_type,P)'" -vsync vfr fallback_%03d.png
```

### Corrupt Output Files?
```bash
# Verify output after extraction
find output_dir -name "*.png" -exec file {} \; | grep -v "PNG image data"

# Regenerate with error handling
ffmpeg -err_detect ignore_err -i video.mp4 -vf "select='gt(scene,0.3)'" -vsync vfr safe_%03d.png
```

### Memory Errors?
```bash
# Reduce complexity by sampling first
ffmpeg -i video.mp4 -vf "fps=0.25" -c copy downsampled.mkv && \
ffmpeg -i downsampled.mkv -vf "select='gt(scene,0.3)'" -vsync vfr sampled_%03d.png && \
rm downsampled.mkv
```

## Useful Combinations

### Create Contact Sheet/Grid
```bash
# Extract frames and create grid using ImageMagick
ffmpeg -i video.mp4 -vf "select='gt(scene,0.3)',scale=-1:72" -vsync vfr tiles_%03d.png && \
montage tiles_*.png -tile 10x5 -geometry +0+0 contact_sheet.jpg && \
rm tiles_*.png
```

### Export Frame Timestamps
```bash
# Get timestamps of all extracted frames
ffmpeg -i video.mp4 -vf "select='gt(scene,0.3)'" -f null - 2>&1 | \
grep -oP "pts_time: \K[0-9.]+" > frame_timestamps.txt
```

### Metadata-Rich Export
```bash
#!/bin/bash
# Add metadata to each extracted frame
ffmpeg -i video.mp4 -vf "select='gt(scene,0.3)'" -vsync vfr frames_%03d.png

for f in frames_*.png; do
    exiftool -Comment="Extracted from $(basename video.mp4) at scene change" "$f"
done
```
