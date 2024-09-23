FROM node:22-alpine as build

WORKDIR /usr/src/app

RUN apk add --no-cache \
        python3 \
        make \
        g++

COPY package*.json ./

RUN  npm ci

# Copy node_modules and src to the final image
FROM node:22-alpine

WORKDIR /usr/src/app

COPY package*.json ./

COPY --from=build /usr/src/app/node_modules/ ./node_modules/

COPY src/ ./src/
COPY main.js ./main.js

EXPOSE 8080

CMD ["node", "main.js"]
