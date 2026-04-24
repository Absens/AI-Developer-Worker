FROM node:22-bookworm-slim

WORKDIR /workspace

ARG CODEX_CLI_VERSION=0.124.0
ENV CODEX_HOME=/codex-home

RUN apt-get update -o Acquire::Retries=5 \
  && apt-get install -y -o Acquire::Retries=5 --no-install-recommends \
    git curl jq ripgrep ca-certificates openssh-client \
  && npm install -g @openai/codex@${CODEX_CLI_VERSION} \
  && mkdir -p /codex-home \
  && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json* tsconfig.json tsconfig.build.json ./
RUN npm install

COPY src ./src
COPY config ./config
COPY scripts ./scripts

RUN npm run build

RUN chmod +x ./scripts/docker-entrypoint.sh

ENTRYPOINT ["./scripts/docker-entrypoint.sh"]
CMD ["npm", "run", "start"]
