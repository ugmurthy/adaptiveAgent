#!/usr/bin/env python3
"""
Python-based frame extraction tool with advanced similarity detection.
Provides more sophisticated frame differencing and clustering algorithms.
"""

import os
import sys
import argparse
import subprocess
from pathlib import Path
from typing import List, Tuple, Optional
from dataclasses import dataclass
import numpy as np
from PIL import Image


@dataclass
class FrameMetadata:
    """Metadata for an extracted frame"""
    path: str
    timestamp: float
    source_method: str
    priority: int  # Lower = higher priority
    
    def __repr__(self):
        return f"Frame({self.path}, t={self.timestamp:.2f}s)"


def run_ffmpeg(input_file: str, filter_complex: str, output_pattern: str) -> List[str]:
    """Run ffmpeg with given filter and return list of output files."""
    
    cmd = [
        'ffmpeg', '-y', '-i', input_file,
        '-vf', filter_complex,
        '-vsync', 'vfr',
        output_pattern
    ]
    
    print(f"Running: {' '.join(cmd)}")
    
    try:
        result = subprocess.run(cmd, capture_output=True, text=True, check=False)
        return True  # Success if we got here
    except Exception as e:
        print(f"Error running ffmpeg: {e}")
        return False


def extract_scene_changes(input_file: str, output_dir: str, threshold: float = 0.3) -> List[FrameMetadata]:
    """Extract frames at scene change boundaries."""
    
    output_pattern = os.path.join(output_dir, "scene_%04d.png")
    
    success = run_ffmpeg(
        input_file, 
        f"select='gt(scene,{threshold})'",
        output_pattern
    )
    
    if not success:
        return []
    
    frames = []
    for f in sorted(Path(output_dir).glob("scene_*.png")):
        frames.append(FrameMetadata(
            path=str(f),
            timestamp=0.0,  # Could parse from filename or ffprobe
            source_method="scene",
            priority=1
        ))
    
    print(f"Extracted {len(frames)} scene-change frames")
    return frames


def extract_keyframes(input_file: str, output_dir: str) -> List[FrameMetadata]:
    """Extract I-frames (keyframes) from video."""
    
    output_pattern = os.path.join(output_dir, "keyframe_%04d.png")
    
    success = run_ffmpeg(
        input_file,
        "select='eq(pict_type,I)'",
        output_pattern
    )
    
    if not success:
        return []
    
    frames = []
    for f in sorted(Path(output_dir).glob("keyframe_*.png")):
        frames.append(FrameMetadata(
            path=str(f),
            timestamp=0.0,
            source_method="keyframe",
            priority=2
        ))
    
    print(f"Extracted {len(frames)} keyframes")
    return frames


def extract_periodic(input_file: str, output_dir: str, fps: float = 0.5) -> List[FrameMetadata]:
    """Extract frames at regular intervals."""
    
    output_pattern = os.path.join(output_dir, "periodic_%04d.png")
    interval = 1.0 / fps
    
    success = run_ffmpeg(
        input_file,
        f"select='not(mod(t,{interval}))'",
        output_pattern
    )
    
    if not success:
        return []
    
    frames = []
    for f in sorted(Path(output_dir).glob("periodic_*.png")):
        frames.append(FrameMetadata(
            path=str(f),
            timestamp=0.0,
            source_method="periodic",
            priority=4
        ))
    
    print(f"Extracted {len(frames)} periodic samples")
    return frames


def calculate_histogram(image: np.ndarray, bins: int = 64) -> np.ndarray:
    """Calculate color histogram for an image."""
    
    rgb = image[:, :, :3]
    r_hist, _ = np.histogram(rgb[:, :, 0], bins=bins, range=(0, 256))
    g_hist, _ = np.histogram(rgb[:, :, 1], bins=bins, range=(0, 256))
    b_hist, _ = np.histogram(rgb[:, :, 2], bins=bins, range=(0, 256))
    
    hist = np.concatenate([r_hist, g_hist, b_hist])
    return hist / hist.sum()  # Normalize


def calculate_ssim(image1: np.ndarray, image2: np.ndarray, K1: float = 0.01, K2: float = 0.03) -> float:
    """
    Calculate Structural Similarity Index (SSIM) between two images.
    Returns value between 0 and 1 (1 = identical).
    """
    
    C1 = (K1 * 255) ** 2
    C2 = (K2 * 255) ** 2
    
    mu1 = np.mean(image1)
    mu2 = np.mean(image2)
    
    sigma1_sq = np.var(image1)
    sigma2_sq = np.var(image2)
    sigma12 = np.cov(image1.flatten(), image2.flatten())[0, 1]
    
    ssim = ((2 * mu1 * mu2 + C1) * (2 * sigma12 + C2)) / \
           ((mu1 ** 2 + mu2 ** 2 + C1) * (sigma1_sq + sigma2_sq + C2))
    
    return float(ssim)


def are_similar(frame1_path: str, frame2_path: str, 
                resize_to: Tuple[int, int] = (160, 90),
                threshold: float = 0.85) -> bool:
    """
    Check if two frames are visually similar.
    
    Args:
        frame1_path: Path to first frame
        frame2_path: Path to second frame
        resize_to: Size to resize frames for comparison
        threshold: Similarity threshold (0-1, higher = stricter)
    
    Returns:
        True if frames are similar
    """
    
    img1 = Image.open(frame1_path).resize(resize_to).convert('RGB')
    img2 = Image.open(frame2_path).resize(resize_to).convert('RGB')
    
    arr1 = np.array(img1)
    arr2 = np.array(img2)
    
    # Method 1: MSE-based similarity
    mse = np.mean((arr1 - arr2) ** 2)
    if mse == 0:
        return True
    
    max_val = np.max(arr1) - np.min(arr1)
    if max_val == 0:
        max_val = 1
    
    psnr = 10 * np.log10(255**2 / mse) if mse > 0 else 100
    is_similar_psnr = psnr > 25  # PSNR > 25 usually means similar
    
    # Method 2: Histogram correlation
    hist1 = calculate_histogram(arr1)
    hist2 = calculate_histogram(arr2)
    correlation = np.corrcoef(hist1, hist2)[0, 1]
    is_similar_hist = correlation > 0.9
    
    return is_similar_psnr or is_similar_hist


def deduplicate_frames(frames: List[FrameMetadata], 
                       output_dir: str,
                       similarity_threshold: float = 0.85) -> List[FrameMetadata]:
    """
    Remove duplicate/similar frames while preserving high-priority ones.
    
    Args:
        frames: List of frame metadata objects
        output_dir: Directory for output
        similarity_threshold: Threshold for considering frames as duplicates
    
    Returns:
        List of kept frame paths
    """
    
    print(f"Deduplicating {len(frames)} frames...")
    
    # Sort by priority (lower number = higher priority)
    frames.sort(key=lambda x: (x.priority, x.path))
    
    kept = []
    removed = 0
    
    for frame in frames:
        is_duplicate = False
        
        for kept_frame in kept:
            if are_similar(frame.path, kept_frame.path, threshold=similarity_threshold):
                is_duplicate = True
                break
        
        if not is_duplicate:
            # Keep this frame
            base_name = os.path.basename(frame.path)
            new_name = f"final_{len(kept):04d}.png"
            src_path = frame.path
            dst_path = os.path.join(output_dir, new_name)
            
            # Copy to final location
            img = Image.open(src_path)
            img.save(dst_path)
            
            kept.append(FrameMetadata(
                path=dst_path,
                timestamp=frame.timestamp,
                source_method="dedup",
                priority=0
            ))
        else:
            removed += 1
    
    # Clean up intermediate files
    for frame in frames:
        if frame.path.startswith(os.path.join(output_dir, "scene_")) or \
           frame.path.startswith(os.path.join(output_dir, "keyframe_")) or \
           frame.path.startswith(os.path.join(output_dir, "motion_")) or \
           frame.path.startswith(os.path.join(output_dir, "periodic_")):
            try:
                os.remove(frame.path)
            except OSError:
                pass
    
    print(f"Kept {len(kept)} unique frames, removed {removed} duplicates")
    return kept


def cluster_representative_frames(frames: List[FrameMetadata],
                                   output_dir: str,
                                   num_clusters: int = None,
                                   min_distance: float = 0.2) -> List[FrameMetadata]:
    """
    Select representative frames using k-means-like clustering on image features.
    
    Args:
        frames: List of all extracted frames
        output_dir: Output directory
        num_clusters: Number of clusters (None = auto-detect)
        min_distance: Minimum distance between representatives
    
    Returns:
        List of selected representative frames
    """
    
    from sklearn.cluster import MiniBatchKMeans
    
    print(f"Selecting representative frames via clustering...")
    
    # Extract features from all frames
    features = []
    frame_paths = []
    
    for frame in frames:
        img = Image.open(frame.path).resize((64, 36)).convert('RGB')
        feature = calculate_histogram(np.array(img), bins=32)
        features.append(feature)
        frame_paths.append(frame)
    
    features = np.array(features)
    
    if num_clusters is None:
        # Auto-detect based on min_distance
        num_clusters = min(len(features), 50)
    
    # Run k-means clustering
    kmeans = MiniBatchKMeans(n_clusters=num_clusters, random_state=42)
    labels = kmeans.fit_predict(features)
    
    # For each cluster, select the frame closest to centroid
    representatives = []
    
    for cluster_id in range(num_clusters):
        members = [(i, frame_paths[i]) for i, l in enumerate(labels) if l == cluster_id]
        
        if not members:
            continue
        
        centroid = kmeans.cluster_centers_[cluster_id]
        
        # Find member closest to centroid
        closest_idx, closest_frame = min(
            members, 
            key=lambda x: np.linalg.norm(features[x[0]] - centroid)
        )
        
        representatives.append(closest_frame)
    
    # Save selected frames
    os.makedirs(output_dir, exist_ok=True)
    
    saved = []
    for i, frame in enumerate(representatives[:num_clusters]):
        new_name = f"representative_{i:04d}.png"
        dst_path = os.path.join(output_dir, new_name)
        
        img = Image.open(frame.path)
        img.save(dst_path)
        
        saved.append(FrameMetadata(path=dst_path, timestamp=frame.timestamp, 
                                   source_method="cluster", priority=0))
    
    print(f"Selected {len(saved)} representative frames")
    return saved


def generate_video_summary(input_file: str, output_dir: str, num_frames: int = 30):
    """Generate a summary video from selected frames."""
    
    output_gif = os.path.join(output_dir, "summary.gif")
    output_mp4 = os.path.join(output_dir, "summary.mp4")
    
    # Get all final frames
    frames = sorted(Path(output_dir).glob("final_*.png"))
    
    if not frames:
        print("No frames found to create summary")
        return
    
    # Create GIF
    print(f"Creating summary GIF with {min(len(frames), num_frames)} frames...")
    
    images = []
    for f in frames[:num_frames]:
        img = Image.open(f)
        images.append(img)
    
    if images:
        images[0].save(
            output_gif,
            save_all=True,
            append_images=images[1:],
            duration=200,
            loop=0,
            optimize=True
        )
        print(f"Created: {output_gif}")
    
    # Create MP4 using ffmpeg
    print("Creating summary MP4...")
    
    # Create MPG format file listing all frames
    frame_list = os.path.join(output_dir, "frame_list.txt")
    with open(frame_list, 'w') as fl:
        for f in frames[:num_frames]:
            fl.write(f"file '{f}'\n")
    
    cmd = [
        'ffmpeg', '-y', '-f', 'concat', '-safe', '0',
        '-i', frame_list,
        '-vf', 'fps=2,scale=1280:-1',
        '-c:v', 'libx264', '-pix_fmt', 'yuv420p',
        output_mp4
    ]
    
    subprocess.run(cmd, capture_output=True)
    print(f"Created: {output_mp4}")
    
    # Cleanup
    os.remove(frame_list)


def get_video_info(input_file: str) -> dict:
    """Get video metadata using ffprobe."""
    
    cmd = [
        'ffprobe', '-v', 'error',
        '-show_entries', 'format=duration,size',
        '-show_entries', 'stream=width,height,r_frame_rate',
        '-of', 'json',
        input_file
    ]
    
    result = subprocess.run(cmd, capture_output=True, text=True)
    info = json.loads(result.stdout)
    
    duration = float(info['format']['duration'])
    width = int(info['streams'][0]['width'])
    height = int(info['streams'][0]['height'])
    
    fps_num, fps_den = info['streams'][0]['r_frame_rate'].split('/')
    fps = int(fps_num) / int(fps_den)
    
    return {
        'duration': duration,
        'width': width,
        'height': height,
        'fps': fps,
        'size_bytes': int(info['format']['size'])
    }


def main():
    parser = argparse.ArgumentParser(description="Extract dissimilar frames from video")
    parser.add_argument("input", help="Input video file")
    parser.add_argument("-o", "--output", default="extracted_frames",
                        help="Output directory")
    parser.add_argument("-m", "--method", default="hybrid",
                        choices=["scene", "keyframe", "motion", "all", "hybrid", "cluster"],
                        help="Extraction method")
    parser.add_argument("-t", "--threshold", type=float, default=0.3,
                        help="Scene detection threshold (0.1-1.0)")
    parser.add_argument("--max-frames", type=int, default=None,
                        help="Maximum number of frames to keep")
    parser.add_argument("--summarize", action="store_true",
                        help="Create summary GIF/MP4 after extraction")
    parser.add_argument("-q", "--quiet", action="store_true",
                        help="Suppress progress output")
    
    args = parser.parse_args()
    
    import json  # Import here since it's only needed in get_video_info
    
    # Validate input
    if not os.path.exists(args.input):
        print(f"Error: Input file not found: {args.input}")
        sys.exit(1)
    
    # Create output directory
    os.makedirs(args.output, exist_ok=True)
    
    # Get video info
    print(f"Processing: {args.input}")
    video_info = get_video_info(args.input)
    print(f"Duration: {video_info['duration']:.1f}s, Resolution: {video_info['width']}x{video_info['height']}, FPS: {video_info['fps']:.1f}")
    
    # Execute extraction based on method
    all_frames = []
    
    if args.method == "scene":
        all_frames = extract_scene_changes(args.input, args.output, args.threshold)
    
    elif args.method == "keyframe":
        all_frames = extract_keyframes(args.input, args.output)
    
    elif args.method == "motion":
        all_frames = extract_scene_changes(args.input, args.output, args.threshold / 2)
    
    elif args.method == "hybrid":
        print("Running hybrid extraction (scene + keyframe)...")
        scene_frames = extract_scene_changes(args.input, args.output, args.threshold)
        key_frames = extract_keyframes(args.input, args.output)
        all_frames = scene_frames + key_frames
        all_frames = deduplicate_frames(all_frames, args.output)
    
    elif args.method == "all":
        print("Running ALL extraction methods...")
        scene_frames = extract_scene_changes(args.input, args.output, args.threshold)
        key_frames = extract_keyframes(args.input, args.output)
        motion_frames = extract_scene_changes(args.input, args.output, args.threshold / 2)
        periodic_frames = extract_periodic(args.input, args.output)
        all_frames = scene_frames + key_frames + motion_frames + periodic_frames
        all_frames = deduplicate_frames(all_frames, args.output)
    
    elif args.method == "cluster":
        print("Running cluster-based extraction...")
        # First extract lots of frames
        extract_scene_changes(args.input, args.output, 0.2)
        extract_keyframes(args.input, args.output)
        extract_periodic(args.input, args.output, 1.0)
        
        # Collect all
        temp_frames = []
        for ext in ["scene_*", "keyframe_*", "periodic_*"]:
            for f in Path(args.output).glob(ext + ".png"):
                temp_frames.append(FrameMetadata(
                    path=str(f), timestamp=0, source_method="temp", priority=99
                ))
        
        # Cluster and select representatives
        all_frames = cluster_representative_frames(temp_frames, args.output, 
                                                   num_clusters=args.max_frames)
    
    # Apply max frames limit
    if args.max_frames and len(all_frames) > args.max_frames:
        all_frames = all_frames[:args.max_frames]
        print(f"Limited to {args.max_frames} frames")
    
    # Create summary if requested
    if args.summarize:
        generate_video_summary(args.input, args.output)
    
    # Print summary
    print("\n=== Extraction Complete ===")
    print(f"Output directory: {os.path.abspath(args.output)}")
    print(f"Total frames: {len(all_frames)}")
    
    if all_frames:
        print("\nFirst 10 frames:")
        for f in all_frames[:10]:
            print(f"  {f.path}")


if __name__ == "__main__":
    main()
