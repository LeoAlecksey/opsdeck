#!/usr/bin/env bash
# Every file in an AppImage must be readable — and, if executable, runnable — by every user:
# sandboxes (firejail, the AppImage catalog's tests) mount it as root and start it as another
# user. Tauri's bundler stores AppRun.wrapped with mode 0770 (tauri-apps/tauri#16155); CI puts a
# 0755 copy into its tool cache, and this check fails the build if anything like that comes back.
# Usage: scripts/check-appimage.sh File.AppImage…   (a plain .squashfs works too, for tests)
set -euo pipefail
status=0
for img in "$@"; do
  # an AppImage is a runtime (ELF) followed by the squashfs image
  if [ "$(head -c 4 "$img" | od -An -c | tr -d ' ')" = '177ELF' ]; then
    chmod +x "$img"
    offset="$("$img" --appimage-offset)"
  else
    offset=0
  fi
  # -lln: numeric owners; lines like "-rwxrwx--- 0/0 31552 2026-10-08 12:00 squashfs-root/AppRun.wrapped"
  bad="$(unsquashfs -lln -o "$offset" "$img" | awk '
    $1 ~ /^[-d]/ {
      m = $1; kind = substr(m, 1, 1); oread = substr(m, 8, 1); oexec = substr(m, 10, 1); uexec = substr(m, 4, 1)
      if (oread != "r" || (kind == "d" && oexec != "x") || (kind == "-" && uexec == "x" && oexec != "x")) print m, $NF
    }')"
  if [ -n "$bad" ]; then
    echo "::error::$img: files not readable/runnable by every user:"
    echo "$bad"
    status=1
  else
    echo "✓ $img: all files are readable (and runnable where executable) by every user"
  fi
done
exit $status
