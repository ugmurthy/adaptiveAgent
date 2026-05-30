# Combining Videos Side-by-Side or Top-Bottom with FFmpeg

This guide explains how to combine two MP4 videos that have overlapping creation times (within a minute of each other) into a single video with synchronized frames. We'll cover both **side-by-side** and **top-bottom** layouts.

## Prerequisites

- FFmpeg installed on your system
- Two MP4 video files (e.g., `video1.mp4` and `video2.mp4`)

## Understanding Time Synchronization

When videos have overlapping creation times, you may want to:
1. **Align them by start time** - Both videos start at the same point in the combined output
2. **Trim to common duration** - Only show the overlapping portion
3. **Pad shorter video** - Add black frames to match the longer video

FFmpeg's filter complex can handle these scenarios automatically.

---

## Method 1: Side-by-Side Layout

### Basic Command (No Trimming)

This command places videos side-by-side, padding the shorter one with black:

```bash
ffmpeg -i video1.mp4 -i video2.mp4 \
  -filter_complex "[0:v][1:v]hstack=inputs=2[v]" \
  -map "[v]" -c:a copy output_sidebyside.mp4
```

**Explanation:**
- `-i video1.mp4 -i video2.mp4`: Input both videos
- `[0:v][1:v]`: Select video streams from input 0 and input 1
- `hstack=inputs=2`: Stack horizontally (side-by-side), takes 2 inputs
- `[v]`: Name the output video stream
- `-map "[v]"`: Map the filtered video to output
- `-c:a copy`: Copy audio codec without re-encoding (use only if keeping one audio track)

### With Audio from Both Videos

If you want to mix audio from both videos:

```bash
ffmpeg -i video1.mp4 -i video2.mp4 \
  -filter_complex "[0:v][1:v]hstack=inputs=2[v]; [0:a][1:a]amix=inputs=2[a]" \
  -map "[v]" -map "[a]" output_sidebyside.mp4
```

---

## Method 2: Top-Bottom Layout

### Basic Command (No Trimming)

This command stacks videos vertically (one on top of the other):

```bash
ffmpeg -i video1.mp4 -i video2.mp4 \
  -filter_complex "[0:v][1:v]vstack=inputs=2[v]" \
  -map "[v]" -c:a copy output_topbottom.mp4
```

**Explanation:**
- `vstack=inputs=2`: Stack vertically (top-bottom), takes 2 inputs
- Everything else is similar to the side-by-side version

### With Audio from Both Videos

```bash
ffmpeg -i video1.mp4 -i video2.mp4 \
  -filter_complex "[0:v][1:v]vstack=inputs=2[v]; [0:a][1:a]amix=inputs=2[a]" \
  -map "[v]" -map "[a]" output_topbottom.mp4
```

---

## Advanced Scenarios

### Scenario 1: Matching Video Resolutions

If your videos have different resolutions, you need to scale them first:

#### Side-by-Side with Same Height:
```bash
ffmpeg -i video1.mp4 -i video2.mp4 \
  -filter_complex "[0:v]scale=iw*0.5:-1[scaled1]; [1:v]scale=iw*0.5:-1[scaled2]; \
    [scaled1][scaled2]hstack=inputs=2[v]" \
  -map "[v]" -c:a copy output_resized.mp4
```

#### Top-Bottom with Same Width:
```bash
ffmpeg -i video1.mp4 -i video2.mp4 \
  -filter_complex "[0:v]scale=-1:ih*0.5[scaled1]; [1:v]scale=-1:ih*0.5[scaled2]; \
    [scaled1][scaled2]vstack=inputs=2[v]" \
  -map "[v]" -c:a copy output_resized.mp4
```

### Scenario 2: Trim to Common Duration

If you want to trim both videos to their shortest duration:

```bash
# First, find the duration of both videos
ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 video1.mp4
ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 video2.mp4

# Then use the shorter duration (replace DURATION with actual value)
ffmpeg -t DURATION -i video1.mp4 -t DURATION -i video2.mp4 \
  -filter_complex "[0:v][1:v]hstack=inputs=2[v]" \
  -map "[v]" -c:a copy output_trimmed.mp4
```

### Scenario 3: Add Black Padding for Different Durations

To ensure both videos play for the full duration of the longer one:

```bash
ffmpeg -i video1.mp4 -i video2.mp4 \
  -filter_complex "[0:v]pad=w=iw:h=max(ih,trunc(dar*tb)):x=0:y=0[pad1]; \
    [1:v]pad=w=iw:h=max(ih,trunc(dar*tb)):x=0:y=0[pad2]; \
    [pad1][pad2]hstack=inputs=2[v]" \
  -map "[v]" -c:a copy output_padded.mp4
```

### Scenario 4: Time Offset Adjustment

If videos need to be offset by a specific time (e.g., video2 starts 30 seconds later):

```bash
ffmpeg -ss 00:00:00 -i video1.mp4 -ss 00:00:30 -i video2.mp4 \
  -filter_complex "[0:v][1:v]hstack=inputs=2[v]" \
  -map "[v]" -c:a copy output_offset.mp4
```

---

## Complete Example Commands

### Side-by-Side (Recommended Default)
```bash
ffmpeg -i video1.mp4 -i video2.mp4 \
  -filter_complex "[0:v][1:v]hstack=inputs=2[v]" \
  -map "[v]" -c:v libx264 -preset medium -crf 23 \
  -c:a aac -b:a 128k \
  output_combined_sidebyside.mp4
```

### Top-Bottom (Recommended Default)
```bash
ffmpeg -i video1.mp4 -i video2.mp4 \
  -filter_complex "[0:v][1:v]vstack=inputs=2[v]" \
  -map "[v]" -c:v libx264 -preset medium -crf 23 \
  -c:a aac -b:a 128k \
  output_combined_topbottom.mp4
```

---

## Key Parameters Explained

| Parameter | Description |
|-----------|-------------|
| `hstack=inputs=2` | Horizontal stack (side-by-side) |
| `vstack=inputs=2` | Vertical stack (top-bottom) |
| `-c:v libx264` | Use H.264 video codec |
| `-crf 23` | Constant Rate Factor (18-28, lower = better quality) |
| `-preset medium` | Encoding speed/quality balance |
| `-c:a aac` | Use AAC audio codec |
| `-b:a 128k` | Audio bitrate |

---

## Troubleshooting Tips

1. **Different Frame Rates**: Add `-r 30` before output to force a consistent frame rate
2. **Audio Issues**: Remove `-c:a copy` and let ffmpeg re-encode audio
3. **Black Borders**: Ensure videos have compatible aspect ratios or use scaling filters
4. **Large File Size**: Increase CRF value (up to 28) or reduce resolution

---

## Quick Reference

| Layout | Filter Complex | Output Resolution |
|--------|---------------|-------------------|
| Side-by-Side | `hstack=inputs=2` | Width × 2, Height unchanged |
| Top-Bottom | `vstack=inputs=2` | Width unchanged, Height × 2 |

Choose the layout based on your viewing needs:
- **Side-by-Side**: Better for comparing horizontal content
- **Top-Bottom**: Better for portrait videos or when screen width is limited
