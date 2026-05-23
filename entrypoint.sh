#!/bin/bash
set -e

if [ -n "$SSH_PUBLIC_KEY" ]; then
    mkdir -p /root/.ssh
    echo "$SSH_PUBLIC_KEY" > /root/.ssh/authorized_keys
    chmod 600 /root/.ssh/authorized_keys
fi
ssh-keygen -A 2>/dev/null

mkdir -p /root/data/sandboxes /var/log/supervisor /var/run

echo 1 > /proc/sys/net/ipv4/ip_forward

chmod +x /root/scripts/sandbox* 2>/dev/null || true
ln -sf /root/scripts/sandbox /usr/local/bin/sandbox 2>/dev/null || true

exec /usr/bin/supervisord -c /etc/supervisor/supervisord.conf
