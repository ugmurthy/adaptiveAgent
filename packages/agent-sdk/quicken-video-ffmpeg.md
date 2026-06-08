# Quickening Videos with FFmpeg: Removing Still Frames

When you have a long video with many static or still frames (e.g., 11 minutes of mostly static content), you can use FFmpeg to reduce the video duration by removing or skipping those frames. This guide covers the latest FFmpeg techniques for this purpose.

---

## Understanding the Problem

Videos with lots of still frames (slideshows, presentations, screen recordings, etc.) can be shortened by:
1. **Removing duplicate/consecutive identical frames**
2. **Detecting and keeping only scene changes**
3. **Reducing frame rate intelligently**

---

## Method 1: Using `mpdecimate` Filter (Recommended for Still Frames)

The `mpdecimate` filter drops frames that don't differ significantly from the previous frame. This is ideal for videos with long static portions.

### Basic Command

```bash
ffmpeg -i input.mp4 -vf "mpdecimate" -r:v 0 -c:a copy output.mp4
```

### Key Parameters

| Parameter | Description | Default | Example |
|-----------|-------------|---------|---------|
| `max` | Maximum consecutive frames to drop | 30 | `max=100` |
| `compare` | Comparison method | `diff` | `compare=diff100` |
| `threshold` | Frame difference threshold | 2400 | `threshold=1000` |

### Custom Settings Example

```bash
ffmpeg -i input.mp4 -vf "mpdecimate=max=100:compare=diff:threshold=1000" -r:v 0 -c:a copy output.mp4
```

### Important Notes

- **Variable Frame Rate**: Use `-r:v 0` to enable variable frame rate output. MP4 is a constant frame-rate muxer by default, which can cause timestamp gaps to be filled with duplicated frames.
- **Audio**: The `-c:a copy` flag copies audio without re-encoding. If video duration changes significantly, you may need to adjust audio sync.

---

## Method 2: Scene Detection with `select` Filter

Use the `select` filter to detect and extract only frames where scene changes occur.

### Extract Scene Change Frames

```bash
ffmpeg -i input.mp4 -vf "select=gt(scene,0.4)" -vsync vfr output.mp4
```

### Threshold Values

| Threshold | Sensitivity | Use Case |
|-----------|-------------|----------|
| `0.1` | Very sensitive | Subtle changes |
| `0.2` | Sensitive | General use |
| `0.4` | Moderate | Standard scene changes |
| `0.6` | Less sensitive | Major scene changes only |

### Detect Scene Changes with Timestamps

```bash
ffmpeg -i input.mp4 -filter:v "select='gt(scene,0.4)',showinfo" -f null - 2>&1 | grep "pts_time"
```

---

## Method 3: Combine Both Filters for Best Results

For videos with both static frames and actual scene changes, combine filters:

```bash
ffmpeg -i input.mp4 -vf "mpdecimate,select=gt(scene,0.2)" -vsync vfr -c:a copy output.mp4
```

---

## Method 4: Using PySceneDetect (External Tool)

PySceneDetect is a dedicated scene detection tool that works well with FFmpeg.

### Installation

```bash
pip install scenedetect
```

### Basic Usage

```bash
# Split video at scene changes
scenedetect -i input.mp4 split-video

# High quality mode
scenedetect -i input.mp4 split-video -hq

# Skip first 10 seconds
scenedetect -i input.mp4 time -s 10s split-video
```

---

## Method 5: Using destilate (Specialized Tool)

The [destilate](https://github.com/vaultah/destilate) project is specifically designed for removing static sections from videos.

### Installation

```bash
pip install destilate
```

### Usage

```bash
destilate input.mp4 output.mp4
```

---

## Complete Workflow Example

For an 11-minute video with mostly still frames, here's a complete workflow:

### Step 1: Test with Preview

```bash
ffmpeg -i input.mp4 -vf "mpdecimate=threshold=2000:max=60" -r:v 0 -c:a copy -t 60 preview.mp4
```

### Step 2: Process Full Video

```bash
ffmpeg -i input.mp4 -vf "mpdecimate=threshold=2000:max=100" -r:v 0 -c:a copy output.mp4
```

### Step 3: Verify Output

```bash
ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 output.mp4
```

---

## Troubleshooting

### Issue: Audio Desynchronization

**Solution**: Adjust audio to match video duration:

```bash
ffmpeg -i input.mp4 -vf "mpdecimate" -af "atempo=1.5" -r:v 0 output.mp4
```

### Issue: Output Has Duplicate Frames

**Solution**: Ensure variable frame rate is enabled:

```bash
ffmpeg -i input.mp4 -vf "mpdecimate" -r:v 0 -c:v libx264 -preset slow -crf 23 output.mp4
```

### Issue: No Frames Being Removed

**Solution**: Lower the threshold:

```bash
ffmpeg -i input.mp4 -vf "mpdecimate=threshold=500" -r:v 0 -c:a copy output.mp4
```

---

## Quick Reference Commands

| Goal | Command |
|------|---------|
| Remove still frames (basic) | `ffmpeg -i input.mp4 -vf "mpdecimate" -r:v 0 -c:a copy output.mp4` |
| Remove still frames (aggressive) | `ffmpeg -i input.mp4 -vf "mpdecimate=threshold=1000:max=200" -r:v 0 -c:a copy output.mp4` |
| Keep only scene changes | `ffmpeg -i input.mp4 -vf "select=gt(scene,0.4)" -vsync vfr output.mp4` |
| Combine both methods | `ffmpeg -i input.mp4 -vf "mpdecimate,select=gt(scene,0.2)" -vsync vfr -c:a copy output.mp4` |
| Re-encode with H.264 | `ffmpeg -i input.mp4 -vf "mpdecimate" -c:v libx264 -preset slow -crf 23 -c:a aac output.mp4` |

---

## Summary

For an 11-minute video with mostly still frames:

1. **Start with `mpdecimate`** - It's designed specifically for this use case
2. **Use `-r:v 0`** for variable frame rate output
3. **Adjust `threshold` and `max`** based on your video content
4. **Consider `destilate`** for a more automated solution
5. **Test with a short segment** before processing the full video

The recommended starting command is:

```bash
ffmpeg -i input.mp4 -vf "mpdecimate=threshold=2000:max=100" -r:v 0 -c:a copy output.mp4
```

---

## References

- [FFmpeg Filters Documentation](https://ffmpeg.org/ffmpeg-filters.html)
- [PySceneDetect CLI](https://www.scenedetect.com/cli/)
- [destilate Project](https://github.com/vaultah/destilate)
- [FFmpeg Scene Detection Guide](https://trac.ffmpeg.org/wiki/SceneDetection)
