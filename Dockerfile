FROM node:20-slim

# ffmpeg is required by @dank074/discord-video-stream for video encoding.
RUN apt-get update && apt-get install -y --no-install-recommends \
    ffmpeg \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json .
RUN npm install --omit=dev

COPY . .

CMD ["node", "index.js"]
