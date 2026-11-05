FROM node:18-alpine

WORKDIR /usr/src/app

COPY package*.json ./
RUN npm install --omit=dev

# Ensures index.js and all other source files are copied into /usr/src/app
COPY . .

CMD ["node", "index.js"]