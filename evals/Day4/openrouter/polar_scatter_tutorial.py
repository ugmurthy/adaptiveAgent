"""
Scatter Plots on Polar Axis - Complete Tutorial Examples
This file contains all the code examples from the tutorial.
"""

import matplotlib.pyplot as plt
import numpy as np

# Set random seed for reproducibility
np.random.seed(42)

print("=" * 60)
print("SCATTER PLOTS ON POLAR AXIS - TUTORIAL EXECUTION")
print("=" * 60)

# ============================================================================
# EXAMPLE 1: Basic Polar Scatter Plot
# ============================================================================
print("\n[1/6] Creating Basic Polar Scatter Plot...")

fig = plt.figure(figsize=(8, 8))
ax = fig.add_subplot(111, projection='polar')

# Generate random data
n_points = 100
theta = np.random.uniform(0, 2 * np.pi, n_points)  # Angles in radians
r = np.random.uniform(0, 10, n_points)  # Radii

# Create scatter plot
ax.scatter(theta, r, c='blue', alpha=0.6, s=50)

# Set title and labels
ax.set_title('Basic Polar Scatter Plot', va='bottom')
ax.set_theta_zero_location('N')  # Zero angle at North
ax.set_theta_direction(-1)  # Clockwise direction

plt.tight_layout()
plt.savefig('01_basic_polar_scatter.png', dpi=150, bbox_inches='tight')
plt.close()
print("✓ Saved: 01_basic_polar_scatter.png")

# ============================================================================
# EXAMPLE 2: Customizing Markers and Colors
# ============================================================================
print("\n[2/6] Creating Custom Markers and Colors Plot...")

fig, axes = plt.subplots(1, 2, figsize=(14, 6), subplot_kw={'projection': 'polar'})

# Generate data
n_points = 80
theta = np.random.uniform(0, 2 * np.pi, n_points)
r = np.random.uniform(0, 10, n_points)

# Left subplot - Different marker styles
ax1 = axes[0]
markers = ['o', 's', '^', 'D', 'v', '<', '>', 'p', '*', 'h']
colors = plt.cm.viridis(np.linspace(0, 1, len(markers)))

for i, (marker, color) in enumerate(zip(markers, colors)):
    idx = i * len(theta) // len(markers)
    ax1.scatter(theta[idx], r[idx], marker=marker, s=80, 
                c=color, edgecolors='black', linewidths=1.5, label=f'Marker {i+1}')

ax1.set_title('Various Marker Styles', va='bottom')
ax1.set_theta_zero_location('N')
ax1.set_theta_direction(-1)

# Right subplot - Custom marker sizes
ax2 = axes[1]
sizes = np.random.uniform(50, 300, n_points)
ax2.scatter(theta, r, s=sizes, c='red', alpha=0.5, 
            edgecolors='darkred', linewidths=1, marker='o')

ax2.set_title('Variable Marker Sizes', va='bottom')
ax2.set_theta_zero_location('N')
ax2.set_theta_direction(-1)

plt.tight_layout()
plt.savefig('02_custom_markers_colors.png', dpi=150, bbox_inches='tight')
plt.close()
print("✓ Saved: 02_custom_markers_colors.png")

# ============================================================================
# EXAMPLE 3: Colored Scatter with Magnitude
# ============================================================================
print("\n[3/6] Creating Colored Scatter with Magnitude Plot...")

fig, axes = plt.subplots(1, 3, figsize=(18, 6), subplot_kw={'projection': 'polar'})

# Generate data with magnitude
n_points = 150
theta = np.random.uniform(0, 2 * np.pi, n_points)
r = np.random.uniform(0, 10, n_points)
magnitude = np.random.uniform(0, 1, n_points)

# Different colormaps
colormaps = ['viridis', 'plasma', 'coolwarm']

for ax, cmap in zip(axes, colormaps):
    scatter = ax.scatter(theta, r, c=magnitude, cmap=cmap, 
                         s=100, alpha=0.7, edgecolors='black', linewidths=0.5)
    ax.set_title(f'Colormap: {cmap}', va='bottom')
    ax.set_theta_zero_location('N')
    ax.set_theta_direction(-1)
    
    # Add colorbar
    cbar = plt.colorbar(scatter, ax=ax, shrink=0.6)
    cbar.set_label('Magnitude')

plt.tight_layout()
plt.savefig('03_colored_scatter_magnitude.png', dpi=150, bbox_inches='tight')
plt.close()
print("✓ Saved: 03_colored_scatter_magnitude.png")

# ============================================================================
# EXAMPLE 4: Multiple Data Series
# ============================================================================
print("\n[4/6] Creating Multiple Data Series Plot...")

fig = plt.figure(figsize=(10, 10))
ax = fig.add_subplot(111, projection='polar')

# Generate multiple data series
n_points = 50

# Series 1: Inner ring
theta1 = np.random.uniform(0, 2 * np.pi, n_points)
r1 = np.random.uniform(2, 4, n_points)

# Series 2: Middle ring
theta2 = np.random.uniform(0, 2 * np.pi, n_points)
r2 = np.random.uniform(5, 7, n_points)

# Series 3: Outer ring
theta3 = np.random.uniform(0, 2 * np.pi, n_points)
r3 = np.random.uniform(8, 10, n_points)

# Plot each series
ax.scatter(theta1, r1, c='blue', s=100, alpha=0.6, 
           edgecolors='darkblue', linewidths=1.5, label='Inner Ring')
ax.scatter(theta2, r2, c='green', s=100, alpha=0.6, 
           edgecolors='darkgreen', linewidths=1.5, label='Middle Ring')
ax.scatter(theta3, r3, c='red', s=100, alpha=0.6, 
           edgecolors='darkred', linewidths=1.5, label='Outer Ring')

# Customize axes
ax.set_title('Multiple Data Series on Polar Plot', va='bottom', fontsize=14, fontweight='bold')
ax.set_theta_zero_location('N')
ax.set_theta_direction(-1)

# Add legend
ax.legend(loc='upper right', bbox_to_anchor=(1.3, 1.1))

# Add grid
ax.grid(True, linestyle='--', alpha=0.5)

plt.tight_layout()
plt.savefig('04_multiple_data_series.png', dpi=150, bbox_inches='tight')
plt.close()
print("✓ Saved: 04_multiple_data_series.png")

# ============================================================================
# EXAMPLE 5: Advanced Styling and Annotations
# ============================================================================
print("\n[5/6] Creating Advanced Styling and Annotations Plot...")

fig = plt.figure(figsize=(10, 10))
ax = fig.add_subplot(111, projection='polar')

# Generate data
n_points = 200
theta = np.random.uniform(0, 2 * np.pi, n_points)
r = np.random.uniform(0, 10, n_points)
colors = plt.cm.Spectral(r / 10)

# Create scatter plot
scatter = ax.scatter(theta, r, c=colors, s=80, alpha=0.7, 
                     edgecolors='black', linewidths=0.5)

# Customize radial ticks
ax.set_rticks([2, 4, 6, 8, 10])
ax.set_rlabel_position(45)  # Position of radial labels

# Customize theta ticks (in degrees)
ax.set_xticks(np.deg2rad(np.arange(0, 360, 45)))
ax.set_xticklabels(['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'])

# Set zero angle and direction
ax.set_theta_zero_location('N')
ax.set_theta_direction(-1)

# Add title
ax.set_title('Advanced Polar Scatter with Annotations', 
             va='bottom', fontsize=14, fontweight='bold', pad=20)

# Add annotation
ax.text(np.pi/2, 9, 'Peak Region', ha='center', va='center',
        bbox=dict(boxstyle='round', facecolor='yellow', alpha=0.5),
        fontsize=10, fontweight='bold')

# Customize grid
ax.grid(True, linestyle=':', alpha=0.7)

# Add colorbar
cbar = plt.colorbar(scatter, ax=ax, shrink=0.6, label='Radial Distance')

plt.tight_layout()
plt.savefig('05_advanced_styling_annotations.png', dpi=150, bbox_inches='tight')
plt.close()
print("✓ Saved: 05_advanced_styling_annotations.png")

# ============================================================================
# EXAMPLE 6: Wind Rose Diagram
# ============================================================================
print("\n[6/6] Creating Wind Rose Diagram...")

fig = plt.figure(figsize=(10, 10))
ax = fig.add_subplot(111, projection='polar')

# Simulate wind data (direction in degrees, speed in m/s)
directions = np.random.choice([0, 22.5, 45, 67.5, 90, 112.5, 135, 157.5, 
                               180, 202.5, 225, 247.5, 270, 292.5, 315, 337.5], 
                             size=500, p=[0.05, 0.08, 0.10, 0.12, 0.15, 0.12, 0.10, 0.08,
                                          0.05, 0.08, 0.10, 0.12, 0.15, 0.12, 0.10, 0.08])
speeds = np.random.exponential(5, 500)  # Exponential distribution for wind speeds
speeds = np.clip(speeds, 0, 25)  # Cap at 25 m/s

# Convert to radians (note: wind direction is from where it blows)
theta = np.deg2rad(directions)

# Color based on speed
colors = plt.cm.YlOrRd(speeds / 25)

# Create scatter plot
scatter = ax.scatter(theta, speeds, c=colors, s=30, alpha=0.6, 
                     edgecolors='black', linewidths=0.3)

# Customize axes
ax.set_theta_zero_location('N')
ax.set_theta_direction(-1)

# Set radial ticks (wind speed)
ax.set_rticks([5, 10, 15, 20, 25])
ax.set_rlabel_position(45)

# Set theta ticks
ax.set_xticks(np.deg2rad(np.arange(0, 360, 45)))
ax.set_xticklabels(['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'])

# Add title
ax.set_title('Wind Rose Diagram\n(Scatter Plot Representation)', 
             va='bottom', fontsize=14, fontweight='bold', pad=20)

# Add colorbar
cbar = plt.colorbar(scatter, ax=ax, shrink=0.6)
cbar.set_label('Wind Speed (m/s)')

# Add grid
ax.grid(True, linestyle='--', alpha=0.5)

plt.tight_layout()
plt.savefig('06_wind_rose_diagram.png', dpi=150, bbox_inches='tight')
plt.close()
print("✓ Saved: 06_wind_rose_diagram.png")

# ============================================================================
# SUMMARY
# ============================================================================
print("\n" + "=" * 60)
print("TUTORIAL EXECUTION COMPLETE!")
print("=" * 60)
print("\nGenerated Files:")
print("  1. 01_basic_polar_scatter.png")
print("  2. 02_custom_markers_colors.png")
print("  3. 03_colored_scatter_magnitude.png")
print("  4. 04_multiple_data_series.png")
print("  5. 05_advanced_styling_annotations.png")
print("  6. 06_wind_rose_diagram.png")
print("\nTutorial documentation saved in: polar_scatter_tutorial.md")
print("=" * 60)
