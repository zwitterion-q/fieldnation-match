FROM node:22-alpine AS build
WORKDIR /app
COPY package.json ./
RUN npm install
COPY . .
RUN npm run build

# nginx-unprivileged rather than nginx: it runs as uid 101, keeps its pid and
# cache under /tmp, and listens on 8080 -- which is what lets the pod satisfy
# the `restricted` Pod Security Standard without extra capabilities.
FROM nginxinc/nginx-unprivileged:1.27-alpine
COPY --from=build /app/dist /usr/share/nginx/html
COPY nginx.conf /etc/nginx/conf.d/default.conf
EXPOSE 8080
