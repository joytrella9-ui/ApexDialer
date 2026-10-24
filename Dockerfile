FROM node:20-bookworm

RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY . .
RUN mkdir -p /data

ENV HOST=0.0.0.0
ENV APEX_DB_PATH=/data/apexdialer.db
EXPOSE 3210

CMD ["node", "src/server.js"]
