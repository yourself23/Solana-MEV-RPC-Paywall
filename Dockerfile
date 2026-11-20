FROM node:26-slim
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund
COPY mcp-stdio.mjs ./
COPY api/_lib/mcp-tools.json ./api/_lib/mcp-tools.json
USER node
CMD ["node", "mcp-stdio.mjs"]
