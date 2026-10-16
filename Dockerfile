FROM node:20-alpine

WORKDIR /app

COPY package*.json ./
RUN npm install --omit=dev

COPY . .

# ─── Acción 4: Seguridad — correr como usuario no-root ───
# La imagen node:alpine incluye el usuario 'node' (uid 1000).
# Ajustar propietario del directorio de trabajo antes del switch.
RUN chown -R node:node /app
USER node

EXPOSE 3002

ENV NODE_ENV=production
ENV PORT=3002
ENV FIDS_URL=http://localhost:8080
ENV TV_CONTROLER_URL=http://127.0.0.1:3001

CMD ["node", "server.js"]
