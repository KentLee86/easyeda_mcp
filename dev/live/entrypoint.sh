#!/bin/bash
# Start Xvfb and EasyEDA Pro with a DevTools port bound to the container's
# loopback only. Dev tools reach it from a sidecar container that shares this
# container's network namespace; nothing is published to the host.
set -euo pipefail
display=":${XVFB_DISPLAY:-77}"
cdp_port=${EASYEDA_CDP_PORT:-9222}
# `docker restart` keeps /tmp, and a stale lock makes Xvfb refuse to start.
rm -f "/tmp/.X${display#:}-lock" "/tmp/.X11-unix/X${display#:}"
Xvfb "$display" -screen 0 1920x1080x24 -nolisten tcp >/tmp/xvfb.log 2>&1 &
export DISPLAY=$display
sleep 1
# The launcher process can exit after handing off to the app, so it must not be
# PID 1's child we wait on; keep the container alive independently.
/opt/apps/easyeda-pro/easyeda-pro --no-sandbox --disable-gpu --gtk-version=3 \
    --remote-debugging-port="$cdp_port" >/tmp/easyeda-pro.log 2>&1 &
# Fill the virtual screen once the main window exists: larger canvas renders, and
# extension header menus are not folded into the overflow button.
# The first window is a short-lived loader, so keep resizing during startup.
(
    for _ in $(seq 1 30); do
        for w in $(xdotool search --onlyvisible --name "JLCEDA Pro|EasyEDA Pro" 2>/dev/null); do
            xdotool getwindowgeometry "$w" | grep -q "1920x1080" || xdotool windowmove "$w" 0 0 windowsize "$w" 1920 1080
        done
        sleep 3
    done
) >/dev/null 2>&1 &
exec sleep infinity
