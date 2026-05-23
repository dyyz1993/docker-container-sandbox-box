#!/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "${SCRIPT_DIR}/sandbox-lib.sh"

NET_PREFIX="10.10"

cmd_create() {
    local id=$1
    local ns_pid=$2
    local veth_host="veth-s${id}"
    local veth_ns="veth-c${id}"
    local host_ip="${NET_PREFIX}.${id}.1/24"
    local ns_ip="${NET_PREFIX}.${id}.2/24"

    ip link add "${veth_host}" type veth peer name "${veth_ns}" 2>/dev/null || true
    ip link set "${veth_host}" up
    ip address add "${host_ip}" dev "${veth_host}" 2>/dev/null || true

    ip link set "${veth_ns}" netns "${ns_pid}"
    nsenter -t "${ns_pid}" -n ip link set lo up
    nsenter -t "${ns_pid}" -n ip link set "${veth_ns}" name eth0
    nsenter -t "${ns_pid}" -n ip link set eth0 up
    nsenter -t "${ns_pid}" -n ip address add "${ns_ip}" dev eth0
    nsenter -t "${ns_pid}" -n ip route add default via "${NET_PREFIX}.${id}.1"

    iptables -t nat -A POSTROUTING -s "${NET_PREFIX}.${id}.0/24" -j MASQUERADE 2>/dev/null || true
    sysctl -w net.ipv4.ip_forward=1 >/dev/null 2>&1 || true

    log "network created: id=${id} host=${host_ip} ns=${ns_ip} pid=${ns_pid}"
    echo "${NET_PREFIX}.${id}.2"
}

cmd_destroy() {
    local id=$1
    local veth_host="veth-s${id}"

    ip link del "${veth_host}" 2>/dev/null || true
    iptables -t nat -D POSTROUTING -s "${NET_PREFIX}.${id}.0/24" -j MASQUERADE 2>/dev/null || true

    log "network destroyed: id=${id}"
}

cmd_list() {
    echo "Active sandbox networks:"
    ip link show type veth 2>/dev/null | grep -oP 'veth-s\d+' || echo "  (none)"
}

case "${1:-}" in
    create)  cmd_create "$2" "$3" ;;
    destroy) cmd_destroy "$2" ;;
    list)    cmd_list ;;
    *)
        echo "Usage: sandbox-network.sh {create|destroy|list}"
        exit 1
        ;;
esac
