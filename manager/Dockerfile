FROM node:20-slim

RUN apt-get update && apt-get install -y git --no-install-recommends \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

COPY tsconfig.json ./
COPY src/ ./src/
RUN npm run build \
  && cp -r src/public dist/public

EXPOSE 3000
CMD ["node", "dist/index.js"]
