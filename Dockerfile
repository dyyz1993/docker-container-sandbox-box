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

COPY config/supervisor/supervisord.conf /etc/supervisor/supervisord.conf
COPY config/nginx/nginx.conf /etc/nginx/nginx.conf
COPY scripts/ /root/scripts/
COPY web-ui/ /root/web-ui/
COPY entrypoint.sh /entrypoint.sh
COPY sandbox-bash-extension/ /root/.pi/agent/extensions/sandbox-box/
COPY .pi/sandbox-box.json /root/.pi/

RUN cd /root/web-ui && npm install --production && node -e "require('better-sqlite3')" && echo "better-sqlite3 OK"

RUN cd /root/.pi/agent/extensions/sandbox-box && npm install --production

RUN chmod +x /entrypoint.sh /root/scripts/sandbox*

EXPOSE 80 22 7681

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD curl -f http://localhost/ || exit 1

CMD ["/entrypoint.sh"]
