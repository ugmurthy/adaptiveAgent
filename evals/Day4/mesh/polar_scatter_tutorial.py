"""
Polar Scatter Plots Tutorial - Complete Executable Examples
==========================================================
This script demonstrates various techniques for creating scatter plots on polar axes
using matplotlib. Each example is designed to be run independently or as a complete suite.

Author: Matplotlib Expert
Date: 2024
"""

import matplotlib.pyplot as plt
import numpy as np
from matplotlib.lines import Line2D

# Set random seed for reproducibility
np.random.seed(42)

# =============================================================================
# Example 1: Basic Polar Scatter Plot
# =============================================================================
def example1_basic_polar_scatter():
    """
    Creates a basic polar scatter plot with random data points.
    Demonstrates the fundamental syntax for polar scatter plots.
    """
    print("\n" + "="*60)
    print("Example 1: Basic Polar Scatter Plot")
    print("="*60)
    
    # Create sample data
    n_points = 50
    theta = np.random.uniform(0, 2 * np.pi, n_points)  # Angles from 0 to 2π
    r = np.random.uniform(0, 10, n_points)  # Radii from 0 to 10

    # Create polar scatter plot
    fig = plt.figure(figsize=(8, 8))
    ax = fig.add_subplot(111, projection='polar')

    # Scatter plot
    ax.scatter(theta, r, c='blue', alpha=0.6, s=50)

    # Add title and labels
    ax.set_title('Basic Polar Scatter Plot', va='bottom')
    ax.set_theta_zero_location('N')  # 0 degrees at top (North)
    ax.set_theta_direction(-1)  # Clockwise direction

    plt.tight_layout()
    plt.savefig('basic_polar_scatter.png', dpi=150, bbox_inches='tight')
    print("Saved: basic_polar_scatter.png")
    plt.show()
    plt.close()


# =============================================================================
# Example 2: Customizing Marker Styles and Sizes
# =============================================================================
def example2_custom_markers():
    """
    Demonstrates different marker styles, sizes, and edge customizations.
    """
    print("\n" + "="*60)
    print("Example 2: Customizing Marker Styles and Sizes")
    print("="*60)
    
    # Create data with varying sizes
    n_points = 100
    theta = np.random.uniform(0, 2 * np.pi, n_points)
    r = np.random.uniform(0, 15, n_points)
    sizes = np.random.uniform(20, 200, n_points)  # Variable sizes

    fig = plt.figure(figsize=(10, 10))
    ax = fig.add_subplot(111, projection='polar')

    # Different marker styles
    scatter1 = ax.scatter(theta[:30], r[:30], s=sizes[:30], c='red', 
                          marker='o', alpha=0.7, label='Circles')
    scatter2 = ax.scatter(theta[30:60], r[30:60], s=sizes[30:60], c='green', 
                          marker='s', alpha=0.7, label='Squares')
    scatter3 = ax.scatter(theta[60:], r[60:], s=sizes[60:], c='purple', 
                          marker='^', alpha=0.7, label='Triangles')

    # Customize appearance
    ax.set_title('Polar Scatter with Custom Markers and Sizes', va='bottom', fontsize=14)
    ax.set_theta_zero_location('E')  # 0 degrees at East
    ax.set_theta_direction(1)  # Counter-clockwise
    ax.legend(loc='upper right', bbox_to_anchor=(1.3, 1.1))
    ax.grid(True, alpha=0.3)

    plt.tight_layout()
    plt.savefig('custom_markers_polar.png', dpi=150, bbox_inches='tight')
    print("Saved: custom_markers_polar.png")
    plt.show()
    plt.close()


# =============================================================================
# Example 3: Color Mapping with Colormaps
# =============================================================================
def example3_colormaps():
    """
    Shows how to use different colormaps to encode additional data dimensions.
    """
    print("\n" + "="*60)
    print("Example 3: Color Mapping with Colormaps")
    print("="*60)
    
    # Create data with values for color mapping
    n_points = 200
    theta = np.random.uniform(0, 2 * np.pi, n_points)
    r = np.random.uniform(0, 20, n_points)
    values = np.random.uniform(0, 100, n_points)  # Values for color mapping

    fig, axes = plt.subplots(1, 3, subplot_kw={'projection': 'polar'}, figsize=(18, 6))

    # Colormap 1: viridis
    ax1 = axes[0]
    scatter1 = ax1.scatter(theta, r, c=values, cmap='viridis', s=50, alpha=0.7)
    ax1.set_title('Colormap: viridis', va='bottom')
    plt.colorbar(scatter1, ax=ax1, fraction=0.046, pad=0.04)

    # Colormap 2: plasma
    ax2 = axes[1]
    scatter2 = ax2.scatter(theta, r, c=values, cmap='plasma', s=50, alpha=0.7)
    ax2.set_title('Colormap: plasma', va='bottom')
    plt.colorbar(scatter2, ax=ax2, fraction=0.046, pad=0.04)

    # Colormap 3: coolwarm (diverging)
    ax3 = axes[2]
    scatter3 = ax3.scatter(theta, r, c=values, cmap='coolwarm', s=50, alpha=0.7)
    ax3.set_title('Colormap: coolwarm', va='bottom')
    plt.colorbar(scatter3, ax=ax3, fraction=0.046, pad=0.04)

    plt.suptitle('Polar Scatter with Different Colormaps', fontsize=16, y=1.02)
    plt.tight_layout()
    plt.savefig('colormap_polar_scatter.png', dpi=150, bbox_inches='tight')
    print("Saved: colormap_polar_scatter.png")
    plt.show()
    plt.close()


# =============================================================================
# Example 4: Multiple Data Series with Legend
# =============================================================================
def example4_multiple_series():
    """
    Demonstrates plotting multiple data series on the same polar scatter plot.
    """
    print("\n" + "="*60)
    print("Example 4: Multiple Data Series with Legend")
    print("="*60)
    
    # Create multiple data series
    n_points = 80
    theta = np.linspace(0, 2 * np.pi, n_points)

    # Series 1: Sine wave pattern
    r1 = 5 + 3 * np.sin(3 * theta) + np.random.normal(0, 0.5, n_points)

    # Series 2: Cosine wave pattern  
    r2 = 8 + 2 * np.cos(4 * theta) + np.random.normal(0, 0.5, n_points)

    # Series 3: Spiral pattern
    r3 = 3 + 0.05 * theta * n_points + np.random.normal(0, 0.3, n_points)

    fig = plt.figure(figsize=(10, 10))
    ax = fig.add_subplot(111, projection='polar')

    # Plot each series
    ax.scatter(theta, r1, c='red', s=60, alpha=0.7, label='Sine Pattern', edgecolors='darkred')
    ax.scatter(theta, r2, c='green', s=60, alpha=0.7, label='Cosine Pattern', edgecolors='darkgreen')
    ax.scatter(theta, r3, c='blue', s=60, alpha=0.7, label='Spiral Pattern', edgecolors='darkblue')

    # Customize
    ax.set_title('Multiple Data Series on Polar Scatter Plot', va='bottom', fontsize=14)
    ax.set_theta_zero_location('N')
    ax.set_theta_direction(-1)
    ax.legend(loc='upper right', bbox_to_anchor=(1.25, 1.1), fontsize=10)
    ax.grid(True, linestyle='--', alpha=0.5)

    plt.tight_layout()
    plt.savefig('multiple_series_polar.png', dpi=150, bbox_inches='tight')
    print("Saved: multiple_series_polar.png")
    plt.show()
    plt.close()


# =============================================================================
# Example 5: Wind Rose Style Scatter Plot
# =============================================================================
def example5_wind_rose():
    """
    Creates a wind rose style scatter plot, commonly used in meteorology.
    """
    print("\n" + "="*60)
    print("Example 5: Wind Rose Style Scatter Plot")
    print("="*60)
    
    # Define compass directions
    directions = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW']
    angles = np.array([0, np.pi/4, np.pi/2, 3*np.pi/4, np.pi, 5*np.pi/4, 3*np.pi/2, 7*np.pi/4])

    # Generate wind data (direction and speed)
    n_samples = 500
    dir_indices = np.random.choice(8, n_samples)
    theta = angles[dir_indices]
    speed = np.random.exponential(scale=10, size=n_samples)  # Wind speeds

    # Create color based on speed
    colors = speed

    fig = plt.figure(figsize=(10, 10))
    ax = fig.add_subplot(111, projection='polar')

    # Scatter plot with speed as size and color
    scatter = ax.scatter(theta, speed, c=colors, cmap='YlOrRd', s=50, 
                         alpha=0.6, edgecolors='none')

    # Customize for wind rose appearance
    ax.set_theta_zero_location('N')
    ax.set_theta_direction(-1)
    ax.set_title('Wind Rose Style Scatter Plot', va='bottom', fontsize=14)
    ax.set_yticklabels([])  # Hide radius labels
    ax.set_xticklabels(directions, fontsize=12)

    # Add colorbar
    cbar = plt.colorbar(scatter, ax=ax, fraction=0.046, pad=0.04)
    cbar.set_label('Wind Speed (m/s)', rotation=270, labelpad=15)

    plt.tight_layout()
    plt.savefig('wind_rose_scatter.png', dpi=150, bbox_inches='tight')
    print("Saved: wind_rose_scatter.png")
    plt.show()
    plt.close()


# =============================================================================
# Example 6: Advanced Styling with Annotations
# =============================================================================
def example6_advanced_styling():
    """
    Demonstrates advanced styling with annotations, reference lines, and custom legends.
    """
    print("\n" + "="*60)
    print("Example 6: Advanced Styling with Annotations")
    print("="*60)
    
    # Create data
    n_points = 150
    theta = np.random.uniform(0, 2 * np.pi, n_points)
    r = np.random.uniform(0, 12, n_points)
    categories = np.random.choice(['A', 'B', 'C'], n_points)

    # Color mapping for categories
    color_map = {'A': 'red', 'B': 'blue', 'C': 'green'}
    colors = [color_map[c] for c in categories]

    fig = plt.figure(figsize=(12, 12))
    ax = fig.add_subplot(111, projection='polar')

    # Main scatter plot
    scatter = ax.scatter(theta, r, c=colors, s=80, alpha=0.7, 
                         edgecolors='black', linewidths=1.5)

    # Add concentric circles for reference
    for radius in [3, 6, 9]:
        circle_theta = np.linspace(0, 2 * np.pi, 100)
        ax.plot(circle_theta, np.full(100, radius), 'k--', alpha=0.3, linewidth=1)

    # Annotate some points
    for i in [0, 25, 50, 75, 100]:
        ax.annotate(f'Point {i}', xy=(theta[i], r[i]), 
                    xytext=(theta[i] + 0.2, r[i] + 1),
                    fontsize=8, alpha=0.8,
                    arrowprops=dict(arrowstyle='->', color='black', alpha=0.6))

    # Customize
    ax.set_title('Advanced Polar Scatter with Annotations', va='bottom', fontsize=16)
    ax.set_theta_zero_location('E')
    ax.set_theta_direction(1)
    ax.grid(True, alpha=0.3)

    # Custom legend
    legend_elements = [Line2D([0], [0], marker='o', color='w', 
                              markerfacecolor='red', markersize=10, label='Category A'),
                       Line2D([0], [0], marker='o', color='w', 
                              markerfacecolor='blue', markersize=10, label='Category B'),
                       Line2D([0], [0], marker='o', color='w', 
                              markerfacecolor='green', markersize=10, label='Category C')]
    ax.legend(handles=legend_elements, loc='upper right', bbox_to_anchor=(1.3, 1.1))

    plt.tight_layout()
    plt.savefig('advanced_polar_scatter.png', dpi=150, bbox_inches='tight')
    print("Saved: advanced_polar_scatter.png")
    plt.show()
    plt.close()


# =============================================================================
# Example 7: 3D-like Effect with Depth Coloring
# =============================================================================
def example7_depth_effect():
    """
    Creates a 3D-like effect by using color and size to represent depth.
    """
    print("\n" + "="*60)
    print("Example 7: 3D-like Effect with Depth Coloring")
    print("="*60)
    
    # Create data with depth dimension
    n_points = 300
    theta = np.random.uniform(0, 2 * np.pi, n_points)
    r = np.random.uniform(0, 15, n_points)
    depth = np.random.uniform(0, 1, n_points)  # Depth value

    fig = plt.figure(figsize=(10, 10))
    ax = fig.add_subplot(111, projection='polar')

    # Size and color based on depth
    sizes = 20 + depth * 180  # Larger = closer
    colors = depth  # For colormap

    scatter = ax.scatter(theta, r, c=colors, cmap='Blues', s=sizes, 
                         alpha=0.6, edgecolors='navy', linewidths=0.5)

    # Add depth colorbar
    cbar = plt.colorbar(scatter, ax=ax, fraction=0.046, pad=0.04)
    cbar.set_label('Depth (0=far, 1=near)', rotation=270, labelpad=15)

    # Customize
    ax.set_title('3D-like Effect with Depth Coloring', va='bottom', fontsize=14)
    ax.set_theta_zero_location('N')
    ax.set_theta_direction(-1)
    ax.grid(True, alpha=0.2)

    plt.tight_layout()
    plt.savefig('depth_effect_polar.png', dpi=150, bbox_inches='tight')
    print("Saved: depth_effect_polar.png")
    plt.show()
    plt.close()


# =============================================================================
# Example 8: Real-world Application - Celestial Objects
# =============================================================================
def example8_celestial():
    """
    Simulates plotting celestial objects in polar coordinates.
    """
    print("\n" + "="*60)
    print("Example 8: Real-world Application - Celestial Objects")
    print("="*60)
    
    # Simulate celestial object data
    # Right Ascension (0-24 hours) converted to radians
    ra_hours = np.random.uniform(0, 24, 100)
    ra_rad = ra_hours * (2 * np.pi / 24)

    # Distance in light years
    distance = np.random.exponential(scale=100, size=100)

    # Magnitude (brightness) for color
    magnitude = np.random.uniform(0, 15, 100)

    fig = plt.figure(figsize=(12, 10))
    ax = fig.add_subplot(111, projection='polar')

    # Invert magnitude for color (lower = brighter)
    scatter = ax.scatter(ra_rad, distance, c=magnitude, cmap='inferno', 
                         s=50, alpha=0.7, edgecolors='white', linewidths=0.5)

    # Customize for astronomical appearance
    ax.set_title('Celestial Objects Distribution', va='bottom', fontsize=16, color='white')
    ax.set_theta_zero_location('W')  # West at 0
    ax.set_theta_direction(1)  # Counter-clockwise

    # Set RA labels in hours
    ra_labels = ['0h', '3h', '6h', '9h', '12h', '15h', '18h', '21h']
    ax.set_xticklabels(ra_labels)

    # Dark background for space theme
    ax.set_facecolor('#0a0a1a')
    fig.patch.set_facecolor('#0a0a1a')
    ax.tick_params(colors='white')
    ax.grid(color='gray', alpha=0.3)

    # Colorbar
    cbar = plt.colorbar(scatter, ax=ax, fraction=0.046, pad=0.04)
    cbar.set_label('Apparent Magnitude', rotation=270, labelpad=15, color='white')
    cbar.ax.yaxis.set_tick_params(color='white')

    plt.tight_layout()
    plt.savefig('celestial_polar_scatter.png', dpi=150, bbox_inches='tight', facecolor='#0a0a1a')
    print("Saved: celestial_polar_scatter.png")
    plt.show()
    plt.close()


# =============================================================================
# Main Execution
# =============================================================================
def main():
    """
    Run all examples sequentially.
    """
    print("\n" + "#"*70)
    print("#"*10 + " POLAR SCATTER PLOTS TUTORIAL " + "#"*25)
    print("#"*70)
    print("\nThis tutorial demonstrates 8 different techniques for creating")
    print("scatter plots on polar axes using matplotlib.")
    print("\nEach example will be executed and saved as a PNG file.")
    
    # Run all examples
    example1_basic_polar_scatter()
    example2_custom_markers()
    example3_colormaps()
    example4_multiple_series()
    example5_wind_rose()
    example6_advanced_styling()
    example7_depth_effect()
    example8_celestial()
    
    print("\n" + "="*60)
    print("All examples completed successfully!")
    print("="*60)
    print("\nGenerated files:")
    print("  - basic_polar_scatter.png")
    print("  - custom_markers_polar.png")
    print("  - colormap_polar_scatter.png")
    print("  - multiple_series_polar.png")
    print("  - wind_rose_scatter.png")
    print("  - advanced_polar_scatter.png")
    print("  - depth_effect_polar.png")
    print("  - celestial_polar_scatter.png")
    print("\n" + "#"*70)


if __name__ == "__main__":
    main()
