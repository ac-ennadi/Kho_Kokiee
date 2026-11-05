FROM node:18-alpine

WORKDIR /usr/src/app

COPY package*.json ./
RUN npm install --omit=dev

# Make sure this line exists to copy index.js
COPY . .

CMD ["node", "index.js"]