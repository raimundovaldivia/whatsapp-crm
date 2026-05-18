FROM node:20-alpine

WORKDIR /app

# Instalar dependencias nativas para better-sqlite3
RUN apk add --no-cache python3 make g++

COPY package*.json ./
RUN npm ci --only=production

COPY . .

# Crear directorio de datos
RUN mkdir -p data

EXPOSE 3001

CMD ["node", "src/index.js"]
