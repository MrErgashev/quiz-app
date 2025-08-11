# --- runtime bazasi
FROM node:20.18.0-slim AS base
WORKDIR /app

# --- deps o'rnatish
# Agar lock-fayling bo'lsa npm ci ishlaydi; bo'lmasa npm install'ga tushamiz
# (Fly builder uchun qulay bo'lgan pattern)
COPY server/package*.json ./
RUN if [ -f package-lock.json ]; then \
      npm ci --omit=dev; \
    else \
      npm install --omit=dev; \
    fi

# --- app fayllari
# backend
COPY server/. .
# statik fayllar (public) va data
COPY public ./public
COPY data ./data

ENV NODE_ENV=production
ENV PORT=3000

EXPOSE 3000
CMD ["node", "server.js"]
