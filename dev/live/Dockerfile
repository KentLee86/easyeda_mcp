# EasyEDA Pro (Linux x64 desktop client) under Xvfb with the Chrome DevTools
# Protocol enabled, for live development of the MCP bridge. See docs/live-dev.md.
FROM ubuntu:24.04

ARG EASYEDA_PRO_VERSION=3.2.149
ARG EASYEDA_PRO_URL=https://image.easyeda.com/files/easyeda-pro-linux-x64-3.2.149.zip
ARG EASYEDA_PRO_SHA256=42ffea3a335581e381e9d0c949707a1d589fda25bcde08227759db3b543b9875

ENV DEBIAN_FRONTEND=noninteractive LANG=C.UTF-8

RUN apt-get update && apt-get install -y --no-install-recommends \
        ca-certificates curl unzip \
        xvfb xauth dbus-x11 xdotool x11-utils \
        libgtk-3-0t64 libnss3 libxss1 libasound2t64 libgbm1 libdrm2 \
        libxkbcommon0 libxcomposite1 libxdamage1 libxrandr2 libxtst6 \
        libatk-bridge2.0-0t64 libcups2t64 libsecret-1-0 libnotify4 libxshmfence1 \
        fonts-dejavu-core fonts-noto-cjk \
    && rm -rf /var/lib/apt/lists/*

# Official install.sh copies to /opt/apps/easyeda-pro and ends with a
# "restart now? (y/n)" prompt, answered with "n".
RUN mkdir -p /tmp/eda && cd /tmp/eda \
    && curl -fL --retry 3 -o pro.zip "$EASYEDA_PRO_URL" \
    && echo "$EASYEDA_PRO_SHA256  pro.zip" | sha256sum -c - \
    && unzip -q pro.zip \
    && mkdir -p /usr/share/applications \
    && for s in 16x16 32x32 48x48 64x64 128x128 256x256 512x512; do mkdir -p /usr/share/icons/hicolor/$s/apps; done \
    && echo n | bash install.sh \
    && grep -q "\"version\": \"$EASYEDA_PRO_VERSION" /opt/apps/easyeda-pro/resources/app/package.json \
    && cd / && rm -rf /tmp/eda

# The container runs as the host user (docker run -u) so the activation file
# can stay mode 600; HOME is a volume that keeps activation and settings.
RUN mkdir -p /home/eda && chmod 1777 /home/eda
ENV HOME=/home/eda
COPY --chmod=755 entrypoint.sh /usr/local/bin/easyeda-pro-live
ENTRYPOINT ["/usr/local/bin/easyeda-pro-live"]
