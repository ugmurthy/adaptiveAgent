# Learning 3D Plots with Matplotlib: A Comprehensive Tutorial

Welcome to this hands-on tutorial for creating stunning 3D visualizations using Matplotlib! By the end of this guide, you'll know how to create five different types of 3D plots: scatter plots, line plots (spirals), surface plots, wireframe plots, and contour plots.

## Prerequisites

Before starting, ensure you have the necessary libraries installed:

```bash
pip install matplotlib numpy
```

## Getting Started with 3D Plotting

Matplotlib's 3D functionality is built on top of its 2D plotting system. To enable 3D plotting, you need to import `Axes3D`:

```python
import numpy as np
import matplotlib.pyplot as plt
from mpl_toolkits.mplot3d import Axes3D
```

The `projection='3d'` parameter is key to creating 3D axes from a standard subplot.

---

## Table of Contents

1. [Setup and Basic Configuration](#setup-and-basic-configuration)
2. [3D Scatter Plot](#3d-scatter-plot)
3. [3D Line Plot - Helical Spiral](#3d-line-plot---helical-spiral)
4. [Surface Plot](#surface-plot)
5. [Wireframe Plot](#wireframe-plot)
6. [Contour Plot](#contour-plot)
7. [Customization Tips](#customization-tips)

---

## Setup and Basic Configuration

First, let's set up our environment with some recommended configurations:

```python
import numpy as np
import matplotlib.pyplot as plt
from mpl_toolkits.mplot3d import Axes3D
from matplotlib import cm

# Recommended settings for publication-quality plots
plt.rcParams['figure.dpi'] = 150
plt.rcParams['savefig.dpi'] = 150
```

### Creating Your First 3D Figure

```python
fig = plt.figure(figsize=(10, 8))
ax = fig.add_subplot(111, projection='3d')
```

Key points:
- `figsize=(10, 8)` creates a figure that's 10 inches wide by 8 inches tall
- `add_subplot(111, projection='3d')` creates a 3D axis in a 1x1 grid layout

---

## 3D Scatter Plot

Scatter plots are perfect for visualizing relationships between three variables or showing data clusters in 3D space.

### Complete Example

```python
import numpy as np
import matplotlib.pyplot as plt
from mpl_toolkits.mplot3d import Axes3D

fig = plt.figure(figsize=(10, 8))
ax = fig.add_subplot(111, projection='3d')

# Generate random data points in clusters
n_points = 200

cluster1_x = np.random.normal(0, 0.5, n_points//3)
cluster1_y = np.random.normal(0, 0.5, n_points//3)
cluster1_z = np.random.normal(0, 0.5, n_points//3)

cluster2_x = np.random.normal(3, 0.5, n_points//3)
cluster2_y = np.random.normal(3, 0.5, n_points//3)
cluster2_z = np.random.normal(3, 0.5, n_points//3)

cluster3_x = np.random.normal(-2, 0.5, n_points//3)
cluster3_y = np.random.normal(2, 0.5, n_points//3)
cluster3_z = np.random.normal(4, 0.5, n_points//3)

x = np.concatenate([cluster1_x, cluster2_x, cluster3_x])
y = np.concatenate([cluster1_y, cluster2_y, cluster3_y])
z = np.concatenate([cluster1_z, cluster2_z, cluster3_z])

colors = np.random.rand(len(x))
sizes = np.random.randint(20, 200, len(x))

scatter = ax.scatter(x, y, z, c=colors, cmap='viridis', 
                    s=sizes, alpha=0.6, edgecolors='w', linewidth=0.5)

ax.set_xlabel('X Axis', fontsize=12, fontweight='bold')
ax.set_ylabel('Y Axis', fontsize=12, fontweight='bold')
ax.set_zlabel('Z Axis', fontsize=12, fontweight='bold')
ax.set_title('3D Scatter Plot with Multiple Clusters', fontsize=14, fontweight='bold', pad=15)

cbar = fig.colorbar(scatter, ax=ax, shrink=0.6, pad=0.1)
cbar.set_label('Value', fontsize=10)

ax.view_init(elev=25, azim=45)

plt.tight_layout()
plt.show()
```

### Key Parameters Explained

| Parameter | Description |
|-----------|-------------|
| `c` | Color values for each point |
| `cmap` | Colormap name ('viridis', 'plasma', 'coolwarm', etc.) |
| `s` | Size of markers (scalar or array) |
| `alpha` | Transparency (0 to 1) |
| `edgecolors` | Edge color of markers |
| `view_init(elev, azim)` | Set elevation and azimuth angles |

**Sample Output:**

![3D Scatter Plot](/Users/ugmurthy/riding-amp/AgentSmith/packages/desktop-app/src-tauri/artifacts/scatter_plot.png)

---

## 3D Line Plot - Helical Spiral

Line plots in 3D can show paths, trajectories, or mathematical curves like spirals.

### Complete Example

```python
import numpy as np
import matplotlib.pyplot as plt
from mpl_toolkits.mplot3d import Axes3D
from matplotlib import cm

fig = plt.figure(figsize=(10, 8))
ax = fig.add_subplot(111, projection='3d')

t = np.linspace(0, 10 * np.pi, 500)
x_spiral = np.cos(t)
y_spiral = np.sin(t)
z_spiral = t / (2 * np.pi)

# Create color based on height (z)
norm = plt.Normalize(z_spiral.min(), z_spiral.max())
cmap = cm.plasma

# Plot as segments with individual colors
for i in range(len(t) - 1):
    color = tuple(float(c) for c in cmap(norm(z_spiral[i])))
    ax.plot([x_spiral[i], x_spiral[i+1]], 
            [y_spiral[i], y_spiral[i+1]], 
            [z_spiral[i], z_spiral[i+1]], 
            color=color,
            linewidth=2.5)

ax.set_xlabel('X Axis', fontsize=12, fontweight='bold')
ax.set_ylabel('Y Axis', fontsize=12, fontweight='bold')
ax.set_zlabel('Z Axis (Height)', fontsize=12, fontweight='bold')
ax.set_title('3D Helical Spiral with Color Gradient', fontsize=14, fontweight='bold', pad=15)

ax.view_init(elev=20, azim=-60)

plt.tight_layout()
plt.show()
```

### Understanding the Math

The helix is created using parametric equations:
- **x = cos(t)** - Circular motion in X direction
- **y = sin(t)** - Circular motion in Y direction  
- **z = t / (2π)** - Linear ascent along Z axis

### Alternative: Simple Line Plot

For simpler cases without gradient coloring:

```python
ax.plot(x_spiral, y_spiral, z_spiral, 'b-', linewidth=2, label='Helix')
ax.legend()
```

**Sample Output:**

![3D Spiral Plot](/Users/ugmurthy/riding-amp/AgentSmith/packages/desktop-app/src-tauri/artifacts/spiral_plot.png)

---

## Surface Plot

Surface plots display 3D functions as colored surfaces, ideal for visualizing continuous data over a 2D domain.

### Complete Example

```python
import numpy as np
import matplotlib.pyplot as plt
from mpl_toolkits.mplot3d import Axes3D

fig = plt.figure(figsize=(10, 8))
ax = fig.add_subplot(111, projection='3d')

# Create meshgrid
x = np.linspace(-5, 5, 100)
y = np.linspace(-5, 5, 100)
X, Y = np.meshgrid(x, y)

# Define the function: Z = sin(sqrt(x² + y²))
R = np.sqrt(X**2 + Y**2)
Z = np.sin(R)

surf = ax.plot_surface(X, Y, Z, cmap='coolwarm', 
                      alpha=0.9, antialiased=True,
                      rstride=1, cstride=1)

ax.set_xlabel('X Axis', fontsize=12, fontweight='bold')
ax.set_ylabel('Y Axis', fontsize=12, fontweight='bold')
ax.set_zlabel('Z = sin(sqrt(x² + y²))', fontsize=12, fontweight='bold')
ax.set_title('Surface Plot: Radial Wave Pattern', fontsize=14, fontweight='bold', pad=15)

cbar = fig.colorbar(surf, ax=ax, shrink=0.6, pad=0.1)
cbar.set_label('Amplitude', fontsize=10)

ax.view_init(elev=30, azim=45)

plt.tight_layout()
plt.show()
```

### Key Parameters Explained

| Parameter | Description |
|-----------|-------------|
| `rstride` | Row stride (skip every N rows) |
| `cstride` | Column stride (skip every N columns) |
| `antialiased` | Enable anti-aliasing for smoother appearance |
| `shade` | Apply shading based on surface normals |

### Common Functions to Plot

```python
# Gaussian bell curve
Z = np.exp(-(X**2 + Y**2) / 2)

# Mountain shape
Z = (1 - X/2 + X**3 + Y**3) * np.exp(-X**2 - Y**2)

# Saddle surface
Z = X**2 - Y**2
```

**Sample Output:**

![3D Surface Plot](/Users/ugmurthy/riding-amp/AgentSmith/packages/desktop-app/src-tauri/artifacts/surface_plot.png)

---

## Wireframe Plot

Wireframe plots show the structure of a 3D surface as a grid of lines, making it easy to see the shape and curvature.

### Complete Example

```python
import numpy as np
import matplotlib.pyplot as plt
from mpl_toolkits.mplot3d import Axes3D

fig = plt.figure(figsize=(10, 8))
ax = fig.add_subplot(111, projection='3d')

# Create meshgrid
x = np.linspace(-3, 3, 50)
y = np.linspace(-3, 3, 50)
X, Y = np.meshgrid(x, y)

# Damped oscillation function
Z = np.exp(-(X**2 + Y**2)/2) * np.cos(X) * np.cos(Y)

ax.plot_wireframe(X, Y, Z, rstride=3, cstride=3, 
                 color='royalblue', linewidth=0.5, alpha=0.7)

ax.set_xlabel('X Axis', fontsize=12, fontweight='bold')
ax.set_ylabel('Y Axis', fontsize=12, fontweight='bold')
ax.set_zlabel('Z Value', fontsize=12, fontweight='bold')
ax.set_title('Wireframe Plot: Damped Oscillation', fontsize=14, fontweight='bold', pad=15)

ax.view_init(elev=25, azim=-45)

plt.tight_layout()
plt.show()
```

### Combining Surface and Wireframe

You can overlay wireframes on surfaces for added detail:

```python
surf = ax.plot_surface(X, Y, Z, cmap='viridis', alpha=0.5)
ax.plot_wireframe(X, Y, Z, color='black', linewidth=0.3, alpha=0.5)
```

**Sample Output:**

![3D Wireframe Plot](/Users/ugmurthy/riding-amp/AgentSmith/packages/desktop-app/src-tauri/artifacts/wireframe_plot.png)

---

## Contour Plot

3D contour plots show level curves at different heights, useful for visualizing topography or heat maps in 3D space.

### Complete Example

```python
import numpy as np
import matplotlib.pyplot as plt
from mpl_toolkits.mplot3d import Axes3D

fig = plt.figure(figsize=(10, 8))
ax = fig.add_subplot(111, projection='3d')

# Create meshgrid
x = np.linspace(-4, 4, 50)
y = np.linspace(-4, 4, 50)
X, Y = np.meshgrid(x, y)
Z = np.sin(np.sqrt(X**2 + Y**2))

levels = np.arange(-1, 1.5, 0.25)

# Create filled contour on bottom plane
zs = np.ones_like(Z) * Z.min()
cs = ax.contourf(X, Y, zs, Z, levels=levels, cmap='plasma', alpha=0.8)

# Add contour lines at different heights
for i, level in enumerate(levels):
    z_level = np.ones_like(X) * level
    ax.contour(X, Y, z_level, Z, levels=[level], colors=['cyan'], linewidths=1, linestyles='-')

ax.set_xlabel('X Axis', fontsize=12, fontweight='bold')
ax.set_ylabel('Y Axis', fontsize=12, fontweight='bold')
ax.set_zlabel('Z Value', fontsize=12, fontweight='bold')
ax.set_title('3D Contour Plot', fontsize=14, fontweight='bold', pad=15)

cbar = fig.colorbar(cs, ax=ax, shrink=0.6, pad=0.1)
cbar.set_label('Value', fontsize=10)

ax.view_init(elev=30, azim=45)

plt.tight_layout()
plt.show()
```

### 2D Contour vs 3D Contour

Traditional 2D contour plots can be created with:

```python
plt.figure(figsize=(8, 6))
CS = plt.contourf(X, Y, Z, levels=levels, cmap='plasma')
plt.colorbar(CS)
plt.title('2D Contour Plot')
plt.xlabel('X')
plt.ylabel('Y')
plt.show()
```

**Sample Output:**

![3D Contour Plot](/Users/ugmurthy/riding-amp/AgentSmith/packages/desktop-app/src-tauri/artifacts/contour_plot.png)

---

## Customization Tips

### Changing View Angles

```python
# Set initial view angle
ax.view_init(elev=30, azim=45)

# Rotate interactively (in Jupyter notebooks)
# Or programmatically update:
ax.view_init(elev=45, azim=-60)
plt.draw()
```

### Popular Colormaps

- Sequential: `'viridis'`, `'plasma'`, `'inferno'`, `'magma'`
- Diverging: `'coolwarm'`, `'seismic'`, `'RdBu_r'`
- Cyclic: `'hsv'`, `'twilight'`

### Adding Legends and Annotations

```python
# Add text annotation
ax.text2D(0.05, 0.95, 'Note: This is interesting', transform=ax.transAxes)

# Add legend
line, = ax.plot([0], [0], [0], 'r-', label='Reference Line')
ax.legend(handles=[line])
```

### Saving High-Quality Figures

```python
# Save as PNG with high DPI
plt.savefig('plot.png', dpi=300, bbox_inches='tight')

# Save as PDF (vector format)
plt.savefig('plot.pdf', bbox_inches='tight')

# Save as SVG (scalable vector)
plt.savefig('plot.svg', bbox_inches='tight')
```

### Camera Position Presets

```python
# Top-down view
ax.view_init(elev=90, azim=0)

# Side view
ax.view_init(elev=0, azim=0)

# Isometric view
ax.view_init(elev=35.264, azim=45)
```

---

## Summary

Congratulations! You've learned how to create five essential types of 3D plots with Matplotlib:

| Plot Type | Best For | Key Function |
|-----------|----------|--------------|
| **Scatter** | Discrete data points, clusters | `ax.scatter()` |
| **Line** | Paths, trajectories, curves | `ax.plot()` |
| **Surface** | Continuous functions, fields | `ax.plot_surface()` |
| **Wireframe** | Structure visualization | `ax.plot_wireframe()` |
| **Contour** | Level curves, topography | `ax.contour()`, `ax.contourf()` |

### Quick Reference Template

```python
import numpy as np
import matplotlib.pyplot as plt
from mpl_toolkits.mplot3d import Axes3D

# Setup
fig = plt.figure(figsize=(10, 8))
ax = fig.add_subplot(111, projection='3d')

# Your data here...
# x = ...
# y = ...
# z = ...

# Choose plot type
# ax.scatter(x, y, z)          # Scatter
# ax.plot(x, y, z)             # Line
# ax.plot_surface(X, Y, Z)     # Surface
# ax.plot_wireframe(X, Y, Z)   # Wireframe
# ax.contour(X, Y, Z)          # Contour

# Labels and title
ax.set_xlabel('X')
ax.set_ylabel('Y')
ax.set_zlabel('Z')
ax.set_title('Title')

# Adjust view
ax.view_init(elev=30, azim=45)

# Show or save
plt.tight_layout()
plt.show()
# plt.savefig('output.png', dpi=150)
```

### Next Steps

- Explore animation with `FuncAnimation` for rotating 3D plots
- Try combining multiple plot types in one figure
- Learn about interactive 3D plotting with Plotly or Mayavi
- Experiment with custom lighting and shading effects

Happy plotting! 🎨📊
