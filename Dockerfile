FROM node:22-slim

# Install ffmpeg, Python, pip, and yt-dlp
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
       ffmpeg \
       python3 \
       python3-pip \
       ca-certificates \
    && pip3 install --no-cache-dir --break-system-packages -U yt-dlp \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json ./

RUN npm install --omit=dev --no-audit --no-fund

COPY server.js ./
COPY public ./public

ENV NODE_ENV=production
ENV PORT=3000
ENV TRUST_PROXY=1

EXPOSE 3000

CMD ["node", "server.js"]
