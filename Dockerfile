FROM node:20-alpine

WORKDIR /app

# 优先利用 Docker 层缓存安装依赖
COPY package.json package-lock.json* ./
RUN npm install --omit=dev

COPY server ./server
COPY public ./public

ENV NODE_ENV=production \
    PORT=3000 \
    HOST=0.0.0.0 \
    DATA_DIR=data

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
  CMD wget -qO- http://127.0.0.1:3000/healthz || exit 1

CMD ["node", "server/app.js"]
