# Ai-Agent "web" image: the React UI as static files, served by nginx.
# Multi-stage: stage 1 builds with Node, stage 2 ships only the output (no Node, no source).

FROM node:24-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY vite.config.ts tsconfig.json ./
COPY shared ./shared
COPY web ./web
RUN npm run build

FROM nginx:1.29-alpine
COPY deploy/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/web/dist /usr/share/nginx/html
EXPOSE 80
