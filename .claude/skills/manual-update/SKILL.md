---
name: manual-update
description: Print the manual update steps for the dock-tools server
disable-model-invocation: true
---

Print exactly this, with no extra commentary:

---
**Manual update steps for dock-tools:**

```bash
# 1. Pull latest code
cd /opt/dock-tools
git pull

# 2. Rebuild the image with version info
docker build \
  --build-arg GIT_COMMIT=$(git rev-parse HEAD) \
  --build-arg BUILD_TIME=$(date -u +"%Y-%m-%dT%H:%M:%SZ") \
  -t dock-tools-manager:latest ./manager

# 3. Stop and remove the old container
docker stop script-manager && docker rm script-manager

# 4. Start the new container
docker compose up -d manager

# 5. Reload nginx
docker exec script-nginx nginx -s reload
```
---
