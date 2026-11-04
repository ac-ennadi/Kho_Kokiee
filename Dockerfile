FROM node:18-alpine

WORKDIR /usr/src/app

# Copy package.json explicitly (and package-lock.json if available)
COPY package.json ./
COPY package-lock.json* ./

RUN npm install --omit=dev

COPY . .

CMD ["node", "index.js"]