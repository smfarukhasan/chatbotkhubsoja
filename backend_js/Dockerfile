FROM node:20-alpine AS base

WORKDIR /app

# Install openssl for Prisma compatibility in alpine
RUN apk add --no-cache openssl curl

COPY package*.json ./

RUN npm ci

COPY . .

# Generate Prisma Client
RUN npx prisma generate

FROM base AS development
CMD ["npm", "run", "dev"]

FROM base AS production
RUN npm run build \
    && npm prune --production

EXPOSE 8000

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 CMD curl --fail http://127.0.0.1:8000/api/v1/health || exit 1

CMD ["npm", "start"]
