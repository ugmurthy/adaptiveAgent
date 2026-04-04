# Quick Reference: Polar Scatter Plots in Matplotlib

## Basic Syntax

```python
import matplotlib.pyplot as plt
import numpy as np

# Create polar subplot
fig = plt.figure(figsize=(8, 8))
ax = fig.add_subplot(111, projection='polar')

# Create scatter plot
ax.scatter(theta, r, c='color', s=50, alpha=0.7)
```

## Key Parameters

### Position Parameters
- `theta`: Angular position in radians (0 to 2π)
- `r`: Radial distance from center

### Appearance Parameters
- `c`: Color (single color or array for colormap)
- `s`: Marker size (scalar or array)
- `alpha`: Transparency (0 to 1)
- `marker`: Marker style ('o', 's', '^', 'D', etc.)
- `edgecolors`: Edge color of markers
- `linewidths`: Edge line width

### Colormap Parameters
- `cmap`: Colormap name ('viridis', 'plasma', 'coolwarm', etc.)
- `vmin`, `vmax`: Color scale limits
- `norm`: Normalization method

## Polar Axis Customization

### Set Zero Angle Location
```python
ax.set_theta_zero_location('N')  # North (top)
ax.set_theta_zero_location('E')  # East (right)
ax.set_theta_zero_location('S')  # South (bottom)
ax.set_theta_zero_location('W')  # West (left)
```

### Set Rotation Direction
```python
ax.set_theta_direction(1)   # Counter-clockwise (default)
ax.set_theta_direction(-1)  # Clockwise
```

### Set Radial Limits
```python
ax.set_ylim(0, 20)  # Set radius from 0 to 20
```

### Customize Grid
```python
ax.grid(True, alpha=0.3, linestyle='--')
```

## Common Colormaps

### Sequential
- `viridis` - Default, perceptually uniform
- `plasma` - Vibrant sequential
- `inferno` - Dark to bright
- `magma` - Similar to inferno
- `Blues` - Blue gradient
- `YlOrRd` - Yellow to Orange to Red

### Diverging
- `coolwarm` - Blue to Red
- `RdBu` - Red to Blue
- `seismic` - Blue to Red (symmetric)

## Adding Colorbar

```python
scatter = ax.scatter(theta, r, c=values, cmap='viridis')
plt.colorbar(scatter, ax=ax, fraction=0.046, pad=0.04)
```

## Adding Legend

```python
# For scatter plots with labels
ax.scatter(theta, r, c='red', label='Series 1')
ax.legend(loc='upper right', bbox_to_anchor=(1.2, 1.1))

# Custom legend
from matplotlib.lines import Line2D
legend_elements = [
    Line2D([0], [0], marker='o', color='w', markerfacecolor='red', 
           markersize=10, label='Category A')
]
ax.legend(handles=legend_elements, loc='upper right')
```

## Annotations

```python
ax.annotate('Label', xy=(theta[i], r[i]), 
            xytext=(theta[i] + 0.2, r[i] + 1),
            arrowprops=dict(arrowstyle='->', color='black'))
```

## Saving Figures

```python
plt.savefig('filename.png', dpi=150, bbox_inches='tight')
```

## Common Applications

1. **Wind Roses**: Directional frequency data
2. **Astronomy**: Celestial object positions
3. **Physics**: Particle trajectories
4. **Biology**: Circadian rhythms
5. **Meteorology**: Weather patterns
6. **Navigation**: Bearing and distance data

## Tips for Best Results

1. **Choose appropriate marker sizes**: Avoid overcrowding
2. **Use transparency**: Helps with overplotting (`alpha < 1`)
3. **Add colorbars**: Essential for color-mapped data
4. **Label clearly**: Add titles, legends, and annotations
5. **Adjust zero location**: Match your data's natural reference
6. **Consider grid visibility**: Use `alpha` to reduce clutter
7. **Test different colormaps**: Choose based on data type

## Troubleshooting

### Points not visible
- Check theta values are in radians (0 to 2π)
- Ensure r values are positive
- Verify marker size is large enough

### Colormap not working
- Pass array to `c` parameter
- Ensure values are within colormap range
- Add colorbar for reference

### Legend not showing
- Use `bbox_to_anchor` to position outside plot
- Check `loc` parameter for positioning

### Grid too distracting
- Reduce alpha: `ax.grid(True, alpha=0.2)`
- Change linestyle: `linestyle='--'`
- Remove grid: `ax.grid(False)`

## Resources

- Official Matplotlib Docs: https://matplotlib.org/
- Colormap Gallery: https://matplotlib.org/tutorials/colors/colormaps.html
- Polar Plot Examples: https://matplotlib.org/examples/pylab_examples/polar_scatter.html
