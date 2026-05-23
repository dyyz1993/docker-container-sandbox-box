FROM debian:12

RUN apt-get update && apt-get install -y --no-install-recommends \
    curl wget git nginx supervisor openssh-server \
    iproute2 bridge-utils iputils-ping python3 sqlite3 \
    procps psmisc util-linux \
    && rm -rf /var/lib/apt/lists/*

RUN curl -fsSL https://deb.nodesource.com/setup_22.x | bash - \
    && apt-get install -y nodejs \
    && rm -rf /var/lib/apt/lists/*

RUN mkdir -p /run/sshd /var/log/supervisor /root/data/sandboxes /root/scripts

COPY config/supervisor/supervisord.conf /etc/supervisor/supervisord.conf
COPY config/nginx/nginx.conf /etc/nginx/nginx.conf
COPY entrypoint.sh /entrypoint.sh

RUN chmod +x /entrypoint.sh

EXPOSE 80 22

CMD ["/entrypoint.sh"]
