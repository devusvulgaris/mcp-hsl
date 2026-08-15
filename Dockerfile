# mcp-hsl — HTTP-transport container
FROM node:22-alpine AS build
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src ./src

# npx tsc rather than `npm run build` — package.json build script appends
# `chmod 755 build/stdio.js`, which is irrelevant here and it also breaks
# on Windows.
RUN npx tsc

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY --from=build /app/build ./build

USER node
EXPOSE 8000

CMD ["node", "build/http.js"]
