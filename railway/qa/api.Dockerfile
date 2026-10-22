FROM node:24-alpine
WORKDIR /app
COPY backend/package*.json ./
RUN npm ci --omit=dev --ignore-scripts
COPY backend/src ./src
USER node
EXPOSE 3001
CMD ["node", "src/index.js"]
