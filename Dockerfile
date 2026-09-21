FROM node:20-alpine

WORKDIR /app

ENV NODE_ENV=production

# 先拷贝依赖清单以利用构建缓存
COPY package.json package-lock.json* ./
RUN npm install --omit=dev && npm cache clean --force

COPY . .

EXPOSE 3000

USER node

CMD ["node", "server.js"]
