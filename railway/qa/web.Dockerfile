FROM node:24-alpine AS build
WORKDIR /app
COPY frontend/package*.json ./
RUN npm ci --ignore-scripts
COPY frontend/ ./
ENV VITE_BACKEND_URL=same-origin VITE_CRM_SANDBOX=1
RUN npm run build
FROM node:24-alpine
WORKDIR /app
COPY --from=build /app/dist ./dist
COPY railway/qa/gateway.cjs ./gateway.cjs
USER node
EXPOSE 8080
CMD ["node", "gateway.cjs"]
