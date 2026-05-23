FROM node:22-bookworm-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates curl wget git nginx supervisor openssh-server \
    iproute2 bridge-utils iputils-ping python3 sqlite3 \
    procps psmisc util-linux iptables xz-utils \
    && rm -rf /var/lib/apt/lists/*

RUN ARCH=$(dpkg --print-architecture) && \
    curl -L "https://github.com/tsl0922/ttyd/releases/latest/download/ttyd.${ARCH}" -o /usr/local/bin/ttyd && \
    chmod +x /usr/local/bin/ttyd

RUN mkdir -p /run/sshd /var/log/supervisor /root/data/sandboxes /root/scripts

COPY config/supervisor/supervisord.conf /etc/supervisor/supervisord.conf
COPY config/nginx/nginx.conf /etc/nginx/nginx.conf
COPY entrypoint.sh /entrypoint.sh

RUN chmod +x /entrypoint.sh

EXPOSE 80 22 7681

CMD ["/entrypoint.sh"]
