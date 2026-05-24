#!/bin/bash
set -euo pipefail

IMAGE="ghcr.io/xuyingzhou/sandbox-box:latest"
CONTAINER_NAME="sandbox-box"

echo "=== Sandbox Box Update Script ==="
echo "Image: ${IMAGE}"
echo "Container: ${CONTAINER_NAME}"
echo ""

echo "[1/5] Pulling latest image..."
docker pull "${IMAGE}"

OLD_IMAGE=$(docker inspect --format='{{.Image}}' "${CONTAINER_NAME}" 2>/dev/null || echo "")
NEW_IMAGE=$(docker inspect --format='{{.Id}}' "${IMAGE}" 2>/dev/null || echo "")

if [ -n "${OLD_IMAGE}" ] && [ "${OLD_IMAGE}" = "${NEW_IMAGE}" ]; then
    echo "Image unchanged. Already up to date."
    exit 0
fi

echo "[2/5] Stopping container..."
docker stop "${CONTAINER_NAME}" 2>/dev/null || true

echo "[3/5] Removing old container..."
docker rm "${CONTAINER_NAME}" 2>/dev/null || true

echo "[4/5] Starting new container..."
docker run -d \
    --name "${CONTAINER_NAME}" \
    --restart unless-stopped \
    --privileged \
    -p 9090:80 \
    -p 2201:22 \
    --env-file .env \
    -v "$(pwd)/scripts:/root/scripts" \
    -v "$(pwd)/data:/root/data" \
    -v "$(pwd)/logs:/var/log" \
    -v "$(pwd)/config/nginx:/etc/nginx/custom" \
    "${IMAGE}"

echo "[5/5] Waiting for health check..."
for i in $(seq 1 15); do
    if curl -sf http://localhost:9090/ > /dev/null 2>&1; then
        echo "Container is healthy!"
        echo ""
        echo "Update complete. Old image: ${OLD_IMAGE:0:12}"
        exit 0
    fi
    sleep 2
done

echo "Container started but health check timed out. Check logs:"
echo "  docker logs ${CONTAINER_NAME}"
