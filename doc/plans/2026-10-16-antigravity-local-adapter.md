# Adapter `antigravity_local` (CLI tối giản)

Trạng thái: đã triển khai gói `packages/adapters/antigravity-local` (CLI, chỉ local). Ngày: 2026-10-16.
Đã kiểm chứng: token nằm theo HOME trong container, tách tài khoản bằng HOME hoạt động (mục 3). Hướng dẫn sử dụng: `doc/antigravity-local-adapter.md`.

## 1. Bối cảnh

Gemini CLI (`gemini`) đã chặn đăng nhập tài khoản cá nhân
("This client is no longer supported for Gemini Code Assist for individuals ...
migrate to Antigravity"). Adapter `gemini_local` vì vậy không dùng được với đăng
nhập tài khoản. Antigravity CLI (`agy`) là công cụ thay thế.

## 2. Sự kiện đã kiểm chứng (agy 1.3.5, Linux x86-64, Go, 1 file ~220 MB)

| Hạng mục | Kết quả |
| --- | --- |
| Chạy không tương tác | `agy -p "<prompt>" --output-format json` |
| JSON một lần | `{conversation_id, status, response, duration_seconds, num_turns, usage{input_tokens, output_tokens, thinking_tokens, cache_read_tokens, total_tokens}}` |
| Streaming | `--output-format stream-json` phát NDJSON: `init` (cwd, tools, permission_mode), `step_update` (`text_delta`, `step_type`, `state`), `result` (cùng nội dung JSON một lần) |
| Stdin | `--input-format stream-json` đọc NDJSON, mỗi dòng một lượt (cần `--output-format stream-json`) |
| Tiếp tục phiên | `--conversation <id>` hoặc `-c/--continue` |
| Model | `--model <id>`, danh sách bằng `agy models` (ví dụ `gemini-3.8-flash-medium`, `claude-opus-5-5-low`) |
| Quyền | `--dangerously-skip-permissions`, `--mode accept-edits|auto|plan`, `--sandbox` |
| Thư mục làm việc | cwd của tiến trình, thêm bằng `--add-dir` |
| Trạng thái cục bộ | `$HOME/.gemini/antigravity-cli/` (hội thoại, log, cài đặt) |
| Cách ly theo HOME | `HOME` mới tạo ra thư mục trạng thái riêng và **chưa đăng nhập** (log: `You are not logged into Antigravity`) |
| ACP | Không có cờ ACP trong `--help` |
| Hồ sơ/tài khoản | `--profile` chỉ xuất hiện trong chuỗi của công cụ `agentapi`, không có trong `agy --help`. Có biến `AGY_ACCOUNT` và chế độ `AGY_ADC_AUTH` (Application Default Credentials) trong binary |

## 3. Rủi ro lớn nhất: xác thực trong container

Binary có liên kết thư viện keyring (Secret Service). Trên host token nằm ngoài
`~/.gemini/antigravity-cli` (không có file `oauth_creds.json` kiểu Gemini CLI). Container
không có Secret Service, nên **chưa biết** `agy` lưu token ở đâu khi chạy headless.
Ba hướng, cần thử theo thứ tự:

1. Đăng nhập trong container với `HOME=/paperclip/antigravity-accounts/<acc>` và xem
   token có nằm dưới HOME đó không (nếu có: giữ được qua volume, đúng mô hình đa tài khoản).
2. `AGY_ADC_AUTH` với ADC (`GOOGLE_APPLICATION_CREDENTIALS` hoặc `gcloud auth application-default login`).
   Cần Google Cloud project; model Claude chỉ hiện khi project có quyền.
3. Chạy `agy` trên host và để Paperclip gọi qua adapter `process` (không đưa vào container).

Kết quả kiểm tra trên host (strace): `agy` kết nối `/run/user/<uid>/bus` (Secret Service/keyring của người dùng) và vẫn chạy được khi đổi `HOME` sang thư mục trống. Nghĩa là trên host, token không nằm theo `HOME`, nên **đổi HOME không đủ để tách tài khoản**. Trong container (không có keyring) vị trí lưu token chưa rõ.

Phải xác minh bước 1. Nếu thất bại, chuyển sang 2 hoặc 3.

## 4. Phạm vi adapter tối giản

Chỉ làm lane CLI. Không làm: ACP, remote/sandbox target, AI-connection pool/routing,
injection skills phức tạp, login tự động trong UI.

### Gói mới `packages/adapters/antigravity-local` (mẫu: `kimi-local`)

- `src/index.ts`: `type = "antigravity_local"`, label, `models` (tĩnh + lấy từ `agy models`),
  `agentConfigurationDoc`.
- `src/server/execute.ts`: dựng lệnh
  `agy -p <prompt> --output-format stream-json --model <m> [--conversation <id>] [--dangerously-skip-permissions]`,
  `cwd` = workspace, env từ cấu hình Agent (`HOME`, `AGY_ACCOUNT`, `GOOGLE_APPLICATION_CREDENTIALS`...),
  inject `PAPERCLIP_*` như `gemini-local`, gắn timeout/grace.
- `src/server/parse.ts`: đọc NDJSON → gộp `text_delta`, lấy `conversation_id` làm `sessionId`,
  `usage` → token, `status != SUCCESS` → lỗi; nhận diện thông báo chưa đăng nhập, hết hạn mức.
- `src/server/test.ts`: kiểm tra `agy` có trong PATH, `agy models`, và probe `-p "ok"`;
  báo mã `antigravity_auth_required` khi gặp `not logged into Antigravity`.
- `src/ui/`: `build-config.ts` và `parse-stdout.ts` (mẫu `kimi-local/src/ui`).
- `src/cli/`: định dạng stream cho `paperclipai` CLI.
- Test (vitest): `parse.test.ts`, `execute.test.ts`, `test.test.ts` dùng fixture JSON thật ở trên.

### Đăng ký (tìm theo `gemini_local`/`kimi_local`)

- `packages/shared`: `constants.ts` (adapter type), `environment-support.ts`.
- `server/src/adapters/builtin-adapter-types.ts`, `registry.ts`; `server/src/services/agent-identity.ts`,
  `agent-environment-test.ts` nếu danh sách adapter được liệt kê cứng.
- `ui/src/adapters/` (`adapter-display-registry.ts`, `use-adapter-capabilities.ts`, thư mục `antigravity-local`),
  `ui/src/lib/agent-setup-fields.ts`, `model-utils.ts`.
- `cli/src/adapters/registry.ts`.
- `Dockerfile`: cài `agy`; `docker/gemini-login.sh` → bản `antigravity-login.sh` theo HOME.
- `pnpm-workspace`/`package.json` gốc nếu cần khai báo gói.

Không cần migration DB (adapter type là chuỗi).

## 5. Đa tài khoản

Mỗi Agent đặt `HOME=/paperclip/antigravity-accounts/<acc>` (và/hoặc `AGY_ACCOUNT`)
trong Environment variables. Đăng nhập một lần cho mỗi HOME bằng script.
Chi tiết phụ thuộc kết quả mục 3.

## 6. Kiểm chứng

- Unit: parser và builder chạy với fixture.
- `pnpm --filter @paperclipai/adapter-antigravity-local typecheck` rồi `pnpm -r typecheck`.
- Thủ công: Run test trên UI, giao một task thật, kiểm tra session resume bằng `--conversation`.
- `pnpm check:token-gates` nếu có đổi UI.

## 7. Ước lượng

- Gói adapter: khoảng 800–1.200 dòng gồm test.
- Đăng ký: khoảng 10–15 file, thay đổi nhỏ mỗi file.
- Thời gian lớn nhất nằm ở mục 3 (xác thực container), không nằm ở code.
