FROM node:22-bookworm-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates curl wget git nginx supervisor openssh-server \
    iproute2 bridge-utils iputils-ping python3 sqlite3 \
    procps psmisc util-linux iptables xz-utils ripgrep fd-find \
    build-essential python3-dev \
    && rm -rf /var/lib/apt/lists/*

RUN ARCH=$(case $(dpkg --print-architecture) in amd64) echo "x86_64";; arm64) echo "aarch64";; *) echo $(dpkg --print-architecture);; esac) && \
    curl -L -o /usr/local/bin/ttyd "https://github.com/tsl0922/ttyd/releases/download/1.7.7/ttyd.${ARCH}" && \
    chmod +x /usr/local/bin/ttyd && \
    ttyd --version

RUN mkdir -p /run/sshd /var/log/supervisor /root/data/sandboxes /root/scripts /workspace \
    /root/.pi/agent/extensions/sandbox-box

# Build SDK
COPY sdk/package.json /tmp/sdk-build/package.json
COPY sdk/tsup.config.ts /tmp/sdk-build/tsup.config.ts
COPY sdk/tsconfig.json /tmp/sdk-build/tsconfig.json
COPY sdk/src/ /tmp/sdk-build/src/
RUN cd /tmp/sdk-build && npm install --silent && npx tsup && \
    mkdir -p /root/.pi/agent/extensions/sandbox-box/node_modules/@sandbox-box/containers && \
    cp /tmp/sdk-build/dist/index.js /root/.pi/agent/extensions/sandbox-box/node_modules/@sandbox-box/containers/index.js && \
    cp /tmp/sdk-build/dist/index.d.ts /root/.pi/agent/extensions/sandbox-box/node_modules/@sandbox-box/containers/index.d.ts && \
    echo '{"name":"@sandbox-box/containers","version":"0.1.0","main":"index.js","types":"index.d.ts"}' > /root/.pi/agent/extensions/sandbox-box/node_modules/@sandbox-box/containers/package.json && \
    rm -rf /tmp/sdk-build

COPY config/supervisor/supervisord.conf /etc/supervisor/supervisord.conf
COPY config/nginx/nginx.conf /etc/nginx/nginx.conf
COPY scripts/ /root/scripts/
COPY web-ui/ /root/web-ui/
COPY entrypoint.sh /entrypoint.sh
COPY pi-extension/sandbox-bash.js /root/.pi/agent/extensions/sandbox-box/index.js
COPY pi-extension/package.json /root/.pi/agent/extensions/sandbox-box/

RUN cd /root/web-ui && npm install --production && node -e "require('better-sqlite3')" && echo "better-sqlite3 OK"

RUN npm install -g @dyyz1993/pi-coding-agent@0.74.54 && pi --help > /dev/null && echo "pi OK"

RUN chmod +x /entrypoint.sh /root/scripts/sandbox*

EXPOSE 80 22 7681

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD curl -f http://localhost/ || exit 1

CMD ["/entrypoint.sh"]
