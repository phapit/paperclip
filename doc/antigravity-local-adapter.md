# Adapter `antigravity_local` (Antigravity CLI)

Chạy [Antigravity CLI](https://antigravity.google) (`agy`) như một harness của Paperclip. Đăng nhập bằng
tài khoản Google, không cần API key. Mã nguồn: `packages/adapters/antigravity-local`.

Thiết kế ban đầu và các sự kiện đã kiểm chứng: `doc/plans/2026-10-16-antigravity-local-adapter.md`.

## Cách chạy

```text
agy -p <prompt> --output-format stream-json --dangerously-skip-permissions
    [--conversation <id>] [--model <id>] [--effort <low|medium|high|xhigh|max>] [--add-dir <dir>]
```

- Prompt là đối số, không đọc từ stdin. Thư mục làm việc là cwd của tiến trình.
- Kết quả là NDJSON: `init`, `step_update` (`agent_response`, `tool`), `result` (có `usage`).
- Phiên được tiếp tục bằng `--conversation <id>` khi cwd của phiên đã lưu trùng cwd hiện tại.

## Cài `agy`

Dockerfile cài `agy` bằng installer chính thức vào `/usr/local/bin`:

```bash
curl -fsSL https://antigravity.google/cli/install.sh | bash -s -- --dir /usr/local/bin
```

Container đang chạy (không build lại image):

```bash
docker exec -u root paperclip-server-1 bash -c 'curl -fsSL https://antigravity.google/cli/install.sh | bash -s -- --dir /usr/local/bin'
```

Bản cài trong `/usr/local/bin` thuộc root nên `agy` không tự cập nhật; muốn nâng cấp thì build lại image.

## Đăng nhập và nhiều tài khoản

Token và hội thoại nằm theo `HOME` của tiến trình:

```text
<HOME>/.gemini/antigravity-cli/antigravity-oauth-token   # token đăng nhập
<HOME>/.gemini/antigravity-cli/conversations/            # hội thoại (theo profile)
<HOME>/.gemini/config/skills/                            # skills toàn cục (xem bên dưới)
```

Mỗi tài khoản dùng một `HOME` riêng, ví dụ `/paperclip/antigravity-accounts/acc1`. Đăng nhập bằng script:

```bash
./docker/antigravity-login.sh acc1 acc2
```

Script tạo `HOME`, chạy `agy` tương tác (mở URL, đăng nhập Google, dán mã, gõ `/quit`), rồi kiểm tra token và chạy thử
headless. Sau đó đặt biến môi trường của Agent: `HOME=/paperclip/antigravity-accounts/acc1`.

Trên máy host có keyring, token có thể nằm ở kho khóa của người dùng thay vì `HOME`. Trong container không có
keyring nên token luôn nằm trong `HOME`, và `HOME` khác nhau cho kết quả xác thực khác nhau (đã kiểm chứng).

**Bảo mật:** `antigravity-accounts/` chứa token. Không đưa vào image, không commit, và sao lưu volume
`paperclip_paperclip-data`. Tạo lại volume sẽ mất toàn bộ đăng nhập.

## Tự xoay tài khoản khi hết quota

Trường cấu hình của Agent (có ô nhập trong màn hình sửa Agent):

| Trường | Ý nghĩa |
| --- | --- |
| `accountHomes` | Danh sách `HOME` tuyệt đối, hoặc đúng một mục `"auto"` = mọi profile đã đăng nhập dưới `$PAPERCLIP_HOME/antigravity-accounts` (đổi bằng `PAPERCLIP_ANTIGRAVITY_ACCOUNTS_DIR`). Chỉ chạy local. |
| `quotaCooldownMin` | Số phút bỏ qua một profile sau lỗi hết quota. Mặc định 60. |

Hành vi:
- Khi lỗi giống hết quota, adapter đánh dấu profile đó vào cooldown và chạy lại với profile kế tiếp, mở một hội thoại mới
  (hội thoại chỉ tồn tại trong profile đã tạo ra nó).
- Phiên được lưu kèm `accountHome`. Lần chạy sau thử profile đó trước, tiếp tục bằng `--conversation`, trừ khi profile
  đang cooldown.
- Cooldown nằm trong bộ nhớ của server và mất khi server khởi động lại.
- Hết toàn bộ tài khoản thì lỗi `antigravity_quota_exhausted` kèm thông báo "All N Antigravity account(s) are out of quota".
- Nhận diện hết quota dựa trên mẫu chữ (`quota`, `rate limit`, `resource_exhausted`, `429`, `exhausted`) trong stdout/stderr.
  Thông báo thực tế của `agy` khi hết quota chưa được kiểm chứng; nếu không khớp thì cần bổ sung mẫu trong
  `isAntigravityQuotaExhausted` (`src/server/parse.ts`).

## Skills Paperclip

Skills được liên kết vào `<HOME>/.gemini/config/skills/<tên>` trước mỗi lần chạy; `agy` tự phát hiện thư mục này
(đã kiểm chứng bằng một skill thử). Skill do Paperclip quản lý nhưng không còn được chọn sẽ bị gỡ; skill do người dùng
cài thì giữ nguyên. Với pool tài khoản, skills được liên kết vào từng profile trước khi chạy.

## Remote và sandbox

Adapter chạy được trên môi trường SSH và sandbox: tự cài `agy` nếu thiếu (`SANDBOX_INSTALL_COMMAND`), đồng bộ workspace,
và chép skills vào `.gemini/config/skills` của profile từ xa. **Token đăng nhập không được chép sang máy từ xa**; profile
từ xa phải tự đăng nhập, nếu không sẽ có lỗi `antigravity_auth_required`. `accountHomes` không áp dụng cho remote.
Phần remote/sandbox chưa được chạy thử trên môi trường thật.

## Danh sách model

Server gọi `agy models` bằng một profile đã đăng nhập (profile mặc định, rồi các profile dưới thư mục accounts),
cache 5 phút. Lỗi thì dùng danh sách dự phòng trong `src/index.ts`. Nút làm mới model trên UI gọi lại `agy models`.

## Mã lỗi

| Mã | Nguyên nhân |
| --- | --- |
| `antigravity_auth_required` | Profile chưa đăng nhập hoặc token hết hiệu lực. |
| `antigravity_quota_exhausted` | Hết hạn mức (sau khi đã thử hết pool, nếu có). |
| `adapter_engine_unavailable` | Môi trường không chạy được adapter. |

## Kiểm thử

```bash
cd packages/adapters/antigravity-local && npx vitest run
```

Test dùng `agy` giả (script shell) cho phần xoay tài khoản và fixture JSON thật cho phần đọc kết quả.
