#!/bin/bash

# Script to list all files in current directory with size in KB

echo "Files in current directory with size in KB:"
echo "-------------------------------------------"

# List all files (not directories) with size in human-readable format (KB)
for file in *; do
    if [ -f "$file" ]; then
        # Get file size in bytes and convert to KB
        size_bytes=$(stat -c%s "$file" 2>/dev/null || stat -f%z "$file" 2>/dev/null)
        if [ -n "$size_bytes" ]; then
            # Convert to KB (divide by 1024) and show with 2 decimal places
            size_kb=$(echo "scale=2; $size_bytes / 1024" | bc)
            printf "%-40s %8s KB\n" "$file" "$size_kb"
        fi
    fi
done

# Alternative one-liner using ls command:
# ls -l --block-size=K * 2>/dev/null | grep "^-" | awk '{print $9, $5}'
