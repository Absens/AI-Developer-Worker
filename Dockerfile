FROM node:22-bookworm-slim

WORKDIR /workspace

ENV CODEX_HOME=/codex-home

RUN apt-get update \
  && apt-get install -y --no-install-recommends git curl jq ripgrep ca-certificates \
  && npm install -g @openai/codex \
  && mkdir -p /codex-home \
  && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json* tsconfig.json tsconfig.build.json ./
RUN npm install

COPY src ./src
COPY config ./config
COPY scripts ./scripts

RUN npm run build

CMD ["npm", "run", "start"]
