#!/bin/bash
set -e

echo "======================================================="
echo "   NESTED CANVAS - ANDROID APK BUILD SCRIPT           "
echo "======================================================="

# 1. Cấu hình môi trường Java 17 & Android SDK
export JAVA_HOME="/opt/homebrew/opt/openjdk@17"
export ANDROID_HOME="/Users/macbook/Library/Android/sdk"
export PATH="$JAVA_HOME/bin:$ANDROID_HOME/platform-tools:$PATH"

if [ ! -d "$JAVA_HOME" ]; then
    echo "❌ Không tìm thấy Java tại $JAVA_HOME"
    exit 1
fi

if [ ! -d "$ANDROID_HOME" ]; then
    echo "❌ Không tìm thấy Android SDK tại $ANDROID_HOME"
    exit 1
fi

echo "✔ Java Home: $JAVA_HOME"
echo "✔ Android SDK: $ANDROID_HOME"
echo "✔ Java Version: $($JAVA_HOME/bin/java -version 2>&1 | head -n 1)"

# 2. Build Web Assets
echo ""
echo "📦 Bước 1/4: Đang biên dịch web bundle qua Vite..."
npm run build

# 3. Đồng bộ Capacitor Android
echo ""
echo "🔄 Bước 2/4: Đang đồng bộ assets sang Android project..."
npx cap sync android

# 4. Biên dịch APK qua Gradle
echo ""
echo "⚙️ Bước 3/4: Đang biên dịch APK với Gradle..."
cd android
./gradlew assembleDebug
cd ..

# 5. Xuất APK ra thư mục build-apk
APK_SOURCE="android/app/build/outputs/apk/debug/app-debug.apk"
OUT_DIR="build-apk"
APK_DEST="$OUT_DIR/nestedcanvas-debug.apk"

if [ -f "$APK_SOURCE" ]; then
    mkdir -p "$OUT_DIR"
    cp "$APK_SOURCE" "$APK_DEST"
    echo ""
    echo "======================================================="
    echo "✅ BUILD APK THÀNH CÔNG!"
    echo "📁 Vị trí APK: $APK_DEST"
    ls -lh "$APK_DEST"
    echo "======================================================="

    BUILD_TOOLS_DIR="$ANDROID_HOME/build-tools/35.0.0"
    if [ -f "$BUILD_TOOLS_DIR/apksigner" ]; then
        echo ""
        echo "🔍 Kiểm tra chữ ký số APK:"
        "$BUILD_TOOLS_DIR/apksigner" verify --verbose "$APK_DEST" || true
    fi

    echo ""
    echo "📱 Để cài đặt lên máy Android, chạy lệnh:"
    echo "   adb install -r $APK_DEST"
    echo "======================================================="
else
    echo "❌ Không tìm thấy file APK đầu ra tại $APK_SOURCE"
    exit 1
fi
