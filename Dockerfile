FROM node:20-slim

RUN apt-get update && apt-get install -y \
    chromium \
    fonts-freefont-ttf \
    fonts-noto-color-emoji \
    libgbm1 \
    libnss3 \
    libatk1.0-0 \
    libatk-bridge2.0-0 \
    libcups2 \
    libdrm2 \
    libxkbcommon0 \
    libxcomposite1 \
    libxdamage1 \
    libxfixes3 \
    libxrandr2 \
    libpango-1.0-0 \
    libcairo2 \
    libasound2 \
    libxss1 \
    --no-install-recommends \
    && rm -rf /var/lib/apt/lists/*

ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium

WORKDIR /app

COPY package.json ./
RUN npm install --production

COPY whatsapp-bridge.js ./

EXPOSE 4322

# ✅ Clear Chrome lock files before starting
CMD ["sh", "-c", "rm -rf /app/whatsapp-session/session-mechtrack/SingletonLock /app/whatsapp-session/session-mechtrack/SingletonCookie /app/whatsapp-session/session-mechtrack/.org.chromium.Chromium* 2>/dev/null; node whatsapp-bridge.js"]
