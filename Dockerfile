FROM node:22-alpine
WORKDIR /app
COPY package.json ./
COPY src ./src
COPY public ./public
ENV NODE_ENV=production DB_PATH=/data/carpool.db TRUST_PROXY=1
RUN mkdir -p /data && chown node:node /data
USER node
EXPOSE 3000
CMD ["node", "--no-warnings", "src/server.js"]
