FROM node:20-slim

# ffmpeg is required by @dank074/discord-video-stream for video encoding.
# yt-dlp resolves youtube.com/youtu.be links to a direct media URL ffmpeg can
# actually read (a youtu.be link is just a web page, not a video file).
RUN apt-get update && apt-get install -y --no-install-recommends \
    ffmpeg \
    curl \
    ca-certificates \
    && curl -L https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_linux -o /usr/local/bin/yt-dlp \
    && chmod a+rx /usr/local/bin/yt-dlp \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json .
RUN npm install --omit=dev

COPY . .

CMD ["node", "index.js"]
