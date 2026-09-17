FROM node:20-alpine

WORKDIR /app

RUN apk add --no-cache python3 make g++

COPY package*.json ./

RUN npm ci --omit=dev

COPY server.js ./

ENV NODE_ENV=production
ENV DB_PATH=/app/data/database.sqlite

RUN mkdir -p /app/data

EXPOSE 8080

CMD ["node", "server.js"]