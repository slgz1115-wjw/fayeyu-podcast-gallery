FROM node:22-slim

# Install Python, pip, ffmpeg
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 python3-pip python3-venv ffmpeg \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install Node dependencies
COPY package.json package-lock.json ./
RUN npm ci --production

# Install Python dependencies
COPY requirements.txt ./
RUN pip3 install --break-system-packages -r requirements.txt

# Copy app code
COPY . .

# Create directories for data
RUN mkdir -p audio transcripts

EXPOSE 3456

CMD ["node", "server.js"]
