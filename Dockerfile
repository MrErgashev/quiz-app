FROM node:20.18.0-slim
WORKDIR /app

# package.json(lar)ni ko'chirish
COPY package*.json ./

# Agar lock bor bo'lsa ci ishlaydi, bo'lmasa avtomatik install'ga tushsin
RUN npm ci --omit=dev || npm install --omit=dev

# Boshqa hamma fayllar
COPY . .

ENV NODE_ENV=production
ENV PORT=3000

EXPOSE 3000
CMD ["node", "server/server.js"]
