# Node.js bazasi
FROM node:20.18.0-slim

# Ishchi papka
WORKDIR /app

# Faqat package.json va package-lock.json (agar bor bo'lsa) ko‘chirish
COPY package*.json ./

# Lock bo‘lsa ham bo‘lmasa ham ishlaydi
RUN npm install --omit=dev

# Barcha boshqa fayllarni ko‘chirish
COPY . .

# Muhit sozlamalari
ENV NODE_ENV=production
ENV PORT=3000

# Port ochish
EXPOSE 3000

# Serverni ishga tushirish
CMD ["node", "server/server.js"]
