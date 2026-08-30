FROM node:22-alpine AS build
WORKDIR /build
# Shared event library is compiled in, not published to a registry.
COPY libs/tsevents /build/libs/tsevents
WORKDIR /build/libs/tsevents
RUN npm install && npx tsc

WORKDIR /app
COPY services/payments/package.json ./
RUN npm install
RUN mkdir -p node_modules/@fn && cp -r /build/libs/tsevents node_modules/@fn/tsevents
COPY services/payments/tsconfig.json services/payments/nest-cli.json ./
COPY services/payments/src ./src
RUN npx nest build

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY services/payments/package.json ./
RUN npm install --omit=dev && npm cache clean --force
COPY --from=build /build/libs/tsevents ./node_modules/@fn/tsevents
COPY --from=build /app/dist ./dist
EXPOSE 8000
CMD ["node", "dist/main"]
