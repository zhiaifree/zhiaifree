# 阶段一：构建 Astro 静态文件
FROM node:22-alpine AS builder
WORKDIR /app
COPY package.json pnpm-lock.yaml ./
RUN corepack enable pnpm && pnpm install --frozen-lockfile
COPY . .
# 这里只做静态构建，不抓油价：抓取走 scripts/fetch-oil-price.mjs，
# 由 refresh-oil-price.yml 定时执行并热替换进运行中的容器，
# 构建时不需要（也不应该）消耗上游接口额度。
RUN pnpm run build

# 阶段二：用 Nginx 服务静态文件
FROM nginx:alpine
COPY --from=builder /app/dist /usr/share/nginx/html
EXPOSE 80
CMD ["nginx", "-g", "daemon off;"]