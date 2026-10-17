#!/usr/bin/env bash
# Đăng nhập một hoặc nhiều tài khoản Antigravity (agy) vào container Paperclip.
# Mỗi tài khoản có HOME riêng: /paperclip/antigravity-accounts/<tên>
# Token lưu tại <HOME>/.gemini/antigravity-cli/antigravity-oauth-token
# Dùng: ./antigravity-login.sh acc1 acc2
#       CONTAINER=paperclip-server-1 ./antigravity-login.sh acc1
set -euo pipefail

CONTAINER="${CONTAINER:-paperclip-server-1}"
BASE="/paperclip/antigravity-accounts"
TOKEN_REL=".gemini/antigravity-cli/antigravity-oauth-token"

if [ "$#" -lt 1 ]; then
  echo "Dùng: $0 <acc1> [acc2 ...]" >&2
  exit 1
fi
if ! docker inspect -f '{{.State.Running}}' "$CONTAINER" 2>/dev/null | grep -q true; then
  echo "Container '$CONTAINER' không chạy." >&2
  exit 1
fi
if ! docker exec "$CONTAINER" test -x /usr/local/bin/agy; then
  echo "Chưa có agy trong container. Cài bằng: docker exec -u root $CONTAINER bash -c 'curl -fsSL https://antigravity.google/cli/install.sh | bash -s -- --dir /usr/local/bin'" >&2
  exit 1
fi
for acc in "$@"; do
  [[ "$acc" =~ ^[A-Za-z0-9_-]+$ ]] || { echo "Tên không hợp lệ: '$acc' (chỉ chữ, số, _ và -)." >&2; exit 1; }
done

for acc in "$@"; do
  home="$BASE/$acc"
  echo
  echo "=== Tài khoản: $acc  (HOME=$home) ==="
  docker exec -u root "$CONTAINER" sh -c "mkdir -p '$home' && chown -R node:node '$BASE'"

  if docker exec "$CONTAINER" test -s "$home/$TOKEN_REL"; then
    read -r -p "'$acc' đã có token. Đăng nhập lại? [y/N] " ans
    [[ "$ans" =~ ^[Yy]$ ]] || { echo "Bỏ qua $acc."; continue; }
  fi

  echo "Mở URL trên trình duyệt, đăng nhập Google, dán mã vào đây, rồi gõ /quit để thoát."
  docker exec -it -u node -e HOME="$home" "$CONTAINER" agy || true

  echo "--- Kiểm tra $acc ---"
  if docker exec "$CONTAINER" test -s "$home/$TOKEN_REL"; then
    out="$(docker exec -u node -e HOME="$home" "$CONTAINER" agy -p 'reply with the single word ok' --output-format json 2>&1 | head -c 300 || true)"
    if grep -q '"status":"SUCCESS"' <<<"$out"; then
      echo "OK: $acc đăng nhập và chạy headless thành công."
    else
      echo "CẢNH BÁO: có token nhưng chạy headless lỗi: $out" >&2
    fi
  else
    echo "LỖI: chưa có token cho $acc -> đăng nhập chưa thành công." >&2
  fi
done

echo
echo "Gán cho Agent (adapter Antigravity) Environment variables:"
for acc in "$@"; do echo "  [$acc] HOME=$BASE/$acc"; done
