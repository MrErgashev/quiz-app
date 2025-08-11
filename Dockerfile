# Node.js bazasi
FROM node:20.18.0-slim AS base
WORKDIR /app

# package.json va lock faylini ko‘chirish
COPY package*.json ./

# Production dependency o‘rnatish
RUN if [ -f package-lock.json ]; then \
      npm ci --omit=dev; \
    else \
      npm install --omit=dev; \
    fi

# Barcha kodlarni ko‘chirish
COPY . .

# Muhit sozlamalari
ENV NODE_ENV=production
ENV PORT=3000

EXPOSE 3000

# Server ishga tushirish
CMD ["node", "server/server.js"]
