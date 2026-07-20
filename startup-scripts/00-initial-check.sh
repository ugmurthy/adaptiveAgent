echo 'Local PostgreSQL credential: '
read -rs  LOCAL_DB_SECRET
echo
echo 'Local MinIO credential: '
read -rs  LOCAL_MINIO_SECRET
echo
echo 'Local JWT signing credential (32+ bytes): '
echo
read -rs  LOCAL_JWT_SECRET
export LOCAL_DB_SECRET LOCAL_MINIO_SECRET LOCAL_JWT_SECRET

# ================== CONFIG ==================
CONTAINERS=(
  "adaptive-agent-postgres"
  "adaptive-redis"
  "adaptive-agent-minio"
)
# ===========================================

echo "🔍 Checking status of adaptive services...\n"

for CONTAINER in "${CONTAINERS[@]}"; do
    if docker ps --filter "name=^${CONTAINER}$" --format "{{.Names}}" | grep -q "^${CONTAINER}$"; then
        echo "✅ $CONTAINER is already running"
    else
        echo "⚠️  $CONTAINER is not running"

        # Check if container exists but is stopped
        if docker ps -a --filter "name=^${CONTAINER}$" --format "{{.Names}}" | grep -q "^${CONTAINER}$"; then
            echo "   → Starting $CONTAINER ..."
            if docker start "$CONTAINER"; then
                echo "   ✅ Started successfully"
            else
                echo "   ❌ Failed to start"
            fi
        else
            echo "   ❌ Container does not exist. You may need to run 'docker compose up -d' or create it."
        fi
    fi
done

echo "\n🎉 All checks completed."

docker run --rm \
  --network container:adaptive-agent-minio \
  -e MC_USER=minioadmin \
  -e MC_SECRET="$LOCAL_MINIO_SECRET" \
  --entrypoint sh \
  minio/mc -c '
    mc alias set local http://127.0.0.1:9000 "$MC_USER" "$MC_SECRET"
    mc mb --ignore-existing local/adaptive-agent-artifacts
    mc anonymous set none local/adaptive-agent-artifacts
  '
 


