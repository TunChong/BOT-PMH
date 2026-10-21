# BOT LINE lấy PMH

Bot nhận cú pháp từ LINE, tự mở hệ thống PMH, đăng nhập bằng tài khoản máy chủ, chọn đúng nhóm/tên PMH, điền mã ST và trả lại code PMH.

## Cú pháp sử dụng

```text
PMH
```

Hiển thị danh sách PMH và số phiếu còn lại.

```text
Lấy PMH Máy lạnh (sản phẩm dưới 10tr) CT Roadshow trị giá 200.000đ
```

Bot sẽ chọn đúng PMH, lấy một code và trả về code, nhân viên, thời gian lấy và ghi chú.

Có thể gửi `PMH <từ khóa>` để lọc danh sách trước khi lấy.

## Cấu hình

Sao chép `.env.example` thành `.env` khi chạy local, hoặc tạo các biến môi trường tương ứng trên máy chủ. Không lưu mật khẩu PMH, LINE channel secret hay access token trong mã nguồn.

Các biến bắt buộc:

- `LINE_CHANNEL_SECRET`
- `LINE_CHANNEL_ACCESS_TOKEN`
- `PMH_URL`
- `PMH_USER`
- `PMH_PASSWORD`
- `PMH_STORE_CODE`

`PMH_STORE_CODE` là giá trị điền vào ô “Nhập mã ST”. Bản mẫu hiện đặt là `112191`; đổi lại nếu mã cửa hàng thực tế khác.

## Kết nối LINE

Trong LINE Developers, đặt Webhook URL:

```text
https://<domain-cua-ban>/callback
```

Bật `Use webhook`. Access token và channel secret chỉ đặt dưới dạng biến môi trường của máy chủ.

## Chạy bằng Docker

```bash
docker build -t pmh-line-bot .
docker run --env-file .env -p 3000:3000 pmh-line-bot
```

Kiểm tra:

```text
GET /health
```

## Chạy local

```bash
npm install
npm start
```

Máy chạy bot cần Chromium tương thích với Playwright. Dockerfile đã dùng image Playwright có sẵn Chromium và phù hợp hơn cho môi trường triển khai lâu dài.

## Lưu ý vận hành

- Bot dùng một hàng đợi tuần tự để tránh hai yêu cầu cùng lấy một PMH trên cùng phiên trình duyệt.
- Bot phản hồi nhanh một tin “Đang xử lý...” rồi push kết quả sau khi hệ thống PMH trả về.
- Không log hoặc gửi lại mật khẩu/token trong lỗi.
- Nếu tài khoản PMH hết phiên, bot tự đăng nhập lại một lần.
