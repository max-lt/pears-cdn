FROM node:22

WORKDIR /usr/src/app

COPY package*.json ./

RUN  npm ci

COPY src/ ./src/
COPY main.js ./main.js

EXPOSE 8080

CMD ["node", "main.js"]
