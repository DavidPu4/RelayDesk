FROM node:24-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-fund
COPY index.html tsconfig.json vite.config.ts ./
COPY src/frontend ./src/frontend
RUN npm run build

FROM node:24-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production HOST=0.0.0.0 PORT=4328
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts --no-fund && mkdir /app/data && chown node:node /app/data
COPY src/backend ./src/backend
COPY --from=build /app/dist ./dist
USER node
EXPOSE 4328
HEALTHCHECK --interval=30s --timeout=5s CMD node -e "fetch('http://127.0.0.1:4328/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "src/backend/server.js"]
