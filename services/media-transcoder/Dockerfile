# Build natively for the target platform (amd64 or arm64); Y4M input is
# included in gifski's default CLI features. No FFmpeg linkage is needed.
FROM rust:1.85-bookworm AS gifski
RUN cargo install gifski --version 1.34.0 --locked --root /opt/gifski

FROM node:24-bookworm-slim
COPY --from=gifski /opt/gifski/bin/gifski /usr/local/bin/gifski
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg ca-certificates && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev
COPY src ./src
USER node
EXPOSE 8787
CMD ["node", "--import", "tsx", "src/server.ts"]
