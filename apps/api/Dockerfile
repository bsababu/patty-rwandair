FROM node:22-alpine AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run prisma:generate && npm run build

FROM node:22-alpine AS production-dependencies
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev --omit=optional

FROM node:22-alpine AS api
WORKDIR /app
ENV NODE_ENV=production
COPY package*.json ./
COPY --from=production-dependencies /app/node_modules ./node_modules
COPY --from=build /app/node_modules/.prisma ./node_modules/.prisma
COPY --from=build /app/dist ./dist
EXPOSE 4000
CMD ["node","dist/main.js"]

FROM build AS migration
WORKDIR /app
ENV NODE_ENV=production
