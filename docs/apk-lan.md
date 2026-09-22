# APK mở frontend qua LAN

Trên máy tính, build frontend và phục vụ bản đã tối ưu:

```sh
npm run build
npm run serve:lan
```

Chạy `npm run sync` trong terminal khác nếu server đồng bộ cổng 8765 chưa chạy.
Điện thoại và máy tính phải cùng mạng LAN; cho phép kết nối tới cổng 3200 và 8765.

Build APK bằng địa chỉ LAN của máy tính:

```sh
npm run build:apk:lan -- http://192.168.1.121:3200
```

Kết quả: `build-apk/nestedcanvas-lan-debug.apk`. APK tự mở frontend từ địa chỉ đã chỉ định.
Đây là bản thử nghiệm nội bộ qua LAN sử dụng `server.url` của Capacitor.
Nếu máy tính đổi IP, cần build lại APK với IP mới; có thể đặt IP cố định trong router.
Mất kết nối sẽ hiện hướng dẫn và nút thử lại.

Sau khi sửa frontend, chạy `npm run build` rồi đóng/mở lại APK; không cần build APK lại.
Thay đổi native/plugin vẫn cần build APK lại. Canvas và JavaScript vẫn chạy trên điện thoại.

APK LAN dùng cùng application ID với bản cũ: cài đặt sẽ cập nhật ứng dụng hiện tại.
Dữ liệu web được lưu theo origin; dữ liệu của bản đóng gói tại localhost không tự xuất hiện
ở địa chỉ LAN. Lưu/đồng bộ bài cần giữ trước khi chuyển bản.

`npm run build:apk` tiếp tục tạo bản đóng gói frontend để chạy độc lập.
Script LAN chỉ tạm thay cấu hình Android sinh ra, rồi khôi phục khi kết thúc.
