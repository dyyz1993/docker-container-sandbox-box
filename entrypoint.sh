#!/bin/bash
set -e

if [ -n "$SSH_PUBLIC_KEY" ]; then
    mkdir -p /root/.ssh
    echo "$SSH_PUBLIC_KEY" > /root/.ssh/authorized_keys
    chmod 600 /root/.ssh/authorized_keys
fi
ssh-keygen -A 2>/dev/null

mkdir -p /root/data/sandboxes /var/log/supervisor /var/log/nginx /var/run /workspace
touch /var/log/sandbox-box.log 2>/dev/null || true

echo 1 > /proc/sys/net/ipv4/ip_forward

chmod +x /root/scripts/sandbox* 2>/dev/null || true
for f in /root/scripts/sandbox*; do
    ln -sf "$f" "/usr/local/bin/$(basename "$f")" 2>/dev/null || true
done

SANDBOX_DB="${SANDBOX_DB:-/root/data/sandbox.db}"

if [ -f "$SANDBOX_DB" ]; then
    source /root/scripts/sandbox-lib.sh 2>/dev/null || true
    db_init 2>/dev/null || true

    SANDBOX_DATA_DIR="${SANDBOX_DATA_DIR:-/root/data/sandboxes}"
    NET_PREFIX="10.10"

    db_query "SELECT name, network_id, port, services FROM sandboxes WHERE status='running';" 2>/dev/null | while IFS='|' read -r name network_id port services; do
        [ -z "$name" ] && continue

        sb_dir="${SANDBOX_DATA_DIR}/${name}"
        [ ! -d "$sb_dir" ] && continue

        escaped_name=$(db_escape "$name")

        log "recovering sandbox '${name}'"

        mkdir -p "${sb_dir}/home/workspace" 2>/dev/null || true
        mount --bind "${sb_dir}/workspace" "${sb_dir}/home/workspace" 2>/dev/null || true

        unshare --net --pid --mount --uts --fork bash -c "
            mount -t proc proc /proc 2>/dev/null || true
            mount --make-private /
            mount --bind ${sb_dir}/home /root
            mkdir -p /workspace 2>/dev/null || true
            mount --bind /root/workspace /workspace 2>/dev/null || true
            hostname ${name} 2>/dev/null || true
            export HOME=/root
            export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
            exec sleep infinity
        " &
        sb_pid=$!
        sleep 0.3

        if ! kill -0 "$sb_pid" 2>/dev/null; then
            log "failed to recover namespace for '${name}'"
            continue
        fi

        ns_ip=$(bash /root/scripts/sandbox-network.sh create "$network_id" "$sb_pid" 2>/dev/null) || true
        if [ -n "$ns_ip" ]; then
            bash /root/scripts/sandbox-nginx.sh add "$name" "$ns_ip" "$port" 2>/dev/null || true
        fi

        db_query "UPDATE sandboxes SET pid=${sb_pid}, status='running' WHERE name='${escaped_name}';" 2>/dev/null || true

        if [ -d /sys/fs/cgroup ]; then
            mkdir -p "/sys/fs/cgroup/sandbox-${name}" 2>/dev/null || true
            echo 536870912 > "/sys/fs/cgroup/sandbox-${name}/memory.max" 2>/dev/null || true
            echo "$sb_pid" > "/sys/fs/cgroup/sandbox-${name}/cgroup.procs" 2>/dev/null || true
        fi

        nsenter -t "$sb_pid" -m -n -p -u -- \
            setsid bash -c "export HOME=/root; export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin; ttyd -p 7681 -W bash" < /dev/null &>/dev/null &
        echo $! > "/sys/fs/cgroup/sandbox-${name}/cgroup.procs" 2>/dev/null || true
        log "ttyd started in recovered sandbox '${name}'"

        start_sh="${sb_dir}/start.sh"
        if [ -f "$start_sh" ]; then
            log "resuming services for sandbox '${name}'"
            while IFS= read -r svc_cmd; do
                [ -z "$svc_cmd" ] && continue
                nsenter -t "$sb_pid" -m -n -p -u -- \
                    setsid bash -c "export HOME=/root; export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin; cd /workspace 2>/dev/null || cd /root; ${svc_cmd}" < /dev/null &>/dev/null &
                sleep 0.1
            done < "$start_sh"
        fi

        log "sandbox '${name}' recovered (pid=${sb_pid})"
    done
fi

exec /usr/bin/supervisord -c /etc/supervisor/supervisord.conf
