FROM node:22-slim

RUN apt-get update && \
    apt-get install -y --no-install-recommends ffmpeg python3 python3-venv make g++ ca-certificates && \
    rm -rf /var/lib/apt/lists/*

RUN python3 -m venv /opt/edge-tts && \
    /opt/edge-tts/bin/pip install --no-cache-dir edge-tts

ENV EDGE_TTS_COMMAND=/opt/edge-tts/bin/edge-tts

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

COPY . .

CMD ["npm", "start"]
