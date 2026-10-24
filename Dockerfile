FROM node:20-bookworm
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY . .
ENV HOST=0.0.0.0
ENV PORT=3210
EXPOSE 3210
CMD ["node", "src/server.js"]
