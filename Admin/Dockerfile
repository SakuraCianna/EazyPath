FROM node:24-bookworm-slim AS build
WORKDIR /workspace/Admin
COPY Admin/package.json Admin/package-lock.json ./
RUN npm ci
COPY Admin ./
ARG VITE_API_BASE_URL=
ENV VITE_API_BASE_URL=$VITE_API_BASE_URL
RUN npm run build

FROM nginx:1.29-alpine
COPY deploy/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /workspace/Admin/dist /usr/share/nginx/html
EXPOSE 80
