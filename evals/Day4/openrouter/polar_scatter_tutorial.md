# Scatter Plots on Polar Axis - Complete Matplotlib Tutorial

## Introduction

Polar scatter plots are powerful visualization tools for displaying data that has an angular component and a radial distance. They're commonly used in:
- Wind rose diagrams (meteorology)
- Directional data analysis
- Circular statistics
- Radar displays
- Astronomy and orbital mechanics

This tutorial covers various aspects of creating scatter plots on polar axes using matplotlib.

---

## Table of Contents

1. [Basic Polar Scatter Plot](#1-basic-polar-scatter-plot)
2. [Customizing Markers and Colors](#2-customizing-markers-and-colors)
3. [Colored Scatter with Magnitude](#3-colored-scatter-with-magnitude)
4. [Multiple Data Series](#4-multiple-data-series)
5. [Advanced Styling and Annotations](#5-advanced-styling-and-annotations)
6. [Wind Rose Diagram](#6-wind-rose-diagram)

---

## 1. Basic Polar Scatter Plot

### Explanation
The foundation of polar plots in matplotlib. We use `subplot` with `projection='polar'` to create a polar coordinate system.

### Code

```python
import matplotlib.pyplot as plt
import numpy as np

# Set random seed for reproducibility
np.random.seed(42)

# Create figure with polar projection
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
plt.show()
print("Figure 1 saved: 01_basic_polar_scatter.png")
```

---

## 2. Customizing Markers and Colors

### Explanation
Enhance visual appeal by using different marker styles, edge colors, and face colors.

### Code

```python
import matplotlib.pyplot as plt
import numpy as np

np.random.seed(42)

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
    idx = (i * len(theta) // len(markers))
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
plt.show()
print("Figure 2 saved: 02_custom_markers_colors.png")
```

---

## 3. Colored Scatter with Magnitude

### Explanation
Use color to encode a third dimension of data (magnitude/intensity) using colormaps.

### Code

```python
import matplotlib.pyplot as plt
import numpy as np

np.random.seed(42)

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
plt.show()
print("Figure 3 saved: 03_colored_scatter_magnitude.png")
```

---

## 4. Multiple Data Series

### Explanation
Plot multiple datasets on the same polar scatter plot with different visual properties.

### Code

```python
import matplotlib.pyplot as plt
import numpy as np

np.random.seed(42)

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
plt.show()
print("Figure 4 saved: 04_multiple_data_series.png")
```

---

## 5. Advanced Styling and Annotations

### Explanation
Add professional touches with custom grid lines, labels, annotations, and radial ticks.

### Code

```python
import matplotlib.pyplot as plt
import numpy as np

np.random.seed(42)

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
plt.show()
print("Figure 5 saved: 05_advanced_styling_annotations.png")
```

---

## 6. Wind Rose Diagram

### Explanation
A practical application: wind rose diagram showing wind direction and speed distribution.

### Code

```python
import matplotlib.pyplot as plt
import numpy as np

np.random.seed(42)

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
plt.show()
print("Figure 6 saved: 06_wind_rose_diagram.png")
```

---

## Key Parameters Reference

| Parameter | Description | Common Values |
|-----------|-------------|---------------|
| `projection='polar'` | Creates polar coordinate system | Required |
| `theta` | Angular coordinate (radians) | 0 to 2π |
| `r` | Radial coordinate | Any positive value |
| `c` | Color of markers | Single color, array, colormap |
| `s` | Marker size | Scalar or array |
| `alpha` | Transparency | 0 to 1 |
| `marker` | Marker style | 'o', 's', '^', 'D', etc. |
| `edgecolors` | Marker edge color | Any color |
| `linewidths` | Edge line width | Positive number |
| `set_theta_zero_location()` | Zero angle position | 'N', 'E', 'S', 'W' |
| `set_theta_direction()` | Angle direction | 1 (CCW), -1 (CW) |

---

## Best Practices

1. **Always use radians** for theta values in matplotlib polar plots
2. **Set theta direction** based on your data context (clockwise for wind, CCW for math)
3. **Use appropriate colormaps** for your data type (sequential, diverging, qualitative)
4. **Add colorbars** when using continuous color scales
5. **Label your axes** clearly, especially for polar plots
6. **Consider alpha blending** for overlapping points
7. **Use edge colors** to improve marker visibility

---

## Conclusion

Polar scatter plots are versatile tools for visualizing directional and radial data. This tutorial covered:
- Basic polar scatter plot creation
- Marker and color customization
- Multi-dimensional data encoding
- Multiple data series
- Advanced styling techniques
- Real-world application (wind rose)

Experiment with these examples to create compelling visualizations for your specific use case!