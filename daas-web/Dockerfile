# Supply a company-approved, preloaded Linux Node >=22.19 image, preferably by digest.
ARG BASE_IMAGE
FROM ${BASE_IMAGE}
WORKDIR /opt/daas
COPY --chown=0:0 dist/ ./
RUN mkdir -p /var/lib/daas && chown 1000:1000 /var/lib/daas
USER 1000:1000
ENV DAAS_HOST=0.0.0.0 DAAS_PORT=3210 DAAS_DATA_DIR=/var/lib/daas NODE_ENV=production
EXPOSE 3210
CMD ["node", "server/main.ts"]
