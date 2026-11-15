# fake-datarails (wave 4, spec 017): built from the compiled dist (`pnpm --filter @landledger/fake-datarails build`),
# no dependencies. Local only: deploy/compose.fake.yml, compose project landledger-fake, OrbStack.
FROM node:22-alpine
WORKDIR /app
RUN mkdir /data && chown node:node /data
COPY package.json ./
COPY dist/ ./dist/
ENV FAKE_DATARAILS_HOST=0.0.0.0 FAKE_DATARAILS_PORT=4819 FAKE_DATARAILS_DATA=/data
EXPOSE 4819
USER node
CMD ["node", "dist/main.js"]
