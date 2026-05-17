FROM node:20-slim

# Install Chromium and all required system libraries for Puppeteer
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

# Use system Chromium instead of downloading via Puppeteer
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium

# Your Railway backend URL — bridge pushes connected state here
ENV RAILWAY_URL=https://mech-production-30d8.up.railway.app

WORKDIR /app

COPY package.json ./
RUN npm install --production

COPY whatsapp-bridge.js ./

EXPOSE 4322

CMD ["node", "whatsapp-bridge.js"]
