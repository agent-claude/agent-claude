FROM node:20-alpine AS builder

RUN apk add --no-cache openssl

WORKDIR /app

COPY package.json package-lock.json* ./

# All deps needed (devDeps required for react-router build)
RUN npm install --legacy-peer-deps

COPY . .

RUN npx prisma generate
RUN npm run build

# ── Runtime stage ──────────────────────────────────────────
FROM node:20-alpine

RUN apk add --no-cache openssl

WORKDIR /app

ENV NODE_ENV=production

COPY --from=builder /app/package.json ./
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/build ./build
COPY --from=builder /app/prisma ./prisma
COPY --from=builder /app/public ./public

RUN npm prune --omit=dev --legacy-peer-deps

EXPOSE 3000

CMD ["sh", "-c", "npx prisma db push && npm run start"]
