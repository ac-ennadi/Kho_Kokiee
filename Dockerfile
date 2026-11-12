FROM node:22-slim

RUN apt-get update && \
    apt-get install -y --no-install-recommends ffmpeg python3 make g++ ca-certificates && \
    rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package*.json ./
RUN npm install --omit=dev

COPY . .

CMD ["npm", "start"]