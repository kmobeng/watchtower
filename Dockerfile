# syntax=docker/dockerfile:1

# ---- build -----------------------------------------------------------------
# Dev dependencies are needed here: the Prisma CLI generates the client and
# `nest build` compiles it into dist, so the runtime image ships plain JS.
FROM node:24-alpine AS build
WORKDIR /app

# Dependency layer first, so editing source does not reinstall packages.
COPY package.json package-lock.json ./
RUN npm ci

COPY prisma ./prisma
COPY prisma.config.ts tsconfig.json tsconfig.build.json nest-cli.json ./
COPY src ./src

RUN npx prisma generate
RUN npm run build

# ---- runtime ---------------------------------------------------------------
FROM node:24-alpine AS runtime
WORKDIR /app

ENV NODE_ENV=production

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

# dist already contains the compiled Prisma client at dist/generated, so no
# schema or generated sources are needed at runtime.
COPY --from=build /app/dist ./dist

# The API never needs to write to the image; drop to the built-in user.
USER node

EXPOSE 3000

HEALTHCHECK --interval=15s --timeout=5s --start-period=20s --retries=5 \
  CMD wget -q -O /dev/null http://127.0.0.1:3000/ || exit 1

# Overridden to `node dist/src/worker.js` by the worker service.
CMD ["node", "dist/src/main.js"]
