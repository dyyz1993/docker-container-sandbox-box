FROM node:22-bookworm-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    curl wget git nginx supervisor openssh-server \
    iproute2 bridge-utils iputils-ping python3 sqlite3 \
    procps psmisc util-linux iptables \
    && rm -rf /var/lib/apt/lists/*

RUN mkdir -p /run/sshd /var/log/supervisor /root/data/sandboxes /root/scripts

COPY config/supervisor/supervisord.conf /etc/supervisor/supervisord.conf
COPY config/nginx/nginx.conf /etc/nginx/nginx.conf
COPY entrypoint.sh /entrypoint.sh

RUN chmod +x /entrypoint.sh

EXPOSE 80 22

CMD ["/entrypoint.sh"]
