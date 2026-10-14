# Containerised signaling server.
#
# Unit IV: Kubernetes case study.
# Unit I (self study): The Role of Virtualization in Distributed Systems -- this is the
# concrete answer to that topic. The signaling tier becomes an image that runs identically
# on a laptop, a CI runner and a cluster node, which is the isolation and portability
# argument for virtualization made real rather than described.
#
#   docker build -f deploy/docker/Dockerfile -t ds-signaling .
#   docker run -p 4444:4444 ds-signaling

# [DS-U1-VIRTUALIZATION] Unit I self study - Role of Virtualization. Containerised signaling tier.
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
# The signaling binary ships inside y-webrtc, so only production deps are needed.
RUN npm ci --omit=dev

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=4444

COPY --from=build /app/node_modules ./node_modules
COPY package.json ./

# Containers should not run as root; a failure in the signaling process should not be a
# root-level failure on the node.
USER node

EXPOSE 4444
CMD ["node", "node_modules/y-webrtc/bin/server.js"]
