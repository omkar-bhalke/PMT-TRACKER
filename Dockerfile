FROM node:20-slim
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates git && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package*.json ./
RUN npm install --omit=dev --no-audit --no-fund
COPY . .
# Railway volume mount path: /data  (session credentials + outbox live here)
ENV DATA_DIR=/data NODE_ENV=production
EXPOSE 3000
CMD ["node", "server.js"]
