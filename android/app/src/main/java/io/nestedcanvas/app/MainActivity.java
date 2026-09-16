package io.nestedcanvas.app;

import android.content.Context;
import android.net.wifi.WifiManager;
import android.os.Bundle;
import android.webkit.JavascriptInterface;
import com.getcapacitor.BridgeActivity;
import org.json.JSONObject;

import java.net.DatagramPacket;
import java.net.DatagramSocket;
import java.net.Inet4Address;
import java.net.InetAddress;
import java.net.InetSocketAddress;
import java.net.NetworkInterface;
import java.nio.charset.StandardCharsets;
import java.util.Collections;
import java.util.List;

public class MainActivity extends BridgeActivity {
    private WifiManager.MulticastLock multicastLock;
    private Thread udpThread;
    private volatile boolean isRunning = true;
    private DatagramSocket udpSocket;

    public class AndroidNativeBridge {
        @JavascriptInterface
        public String getLocalIp() {
            return getDeviceIp();
        }
    }

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        // Khởi tạo MulticastLock để chip Wi-Fi Android không lọc bỏ gói tin UDP Broadcast
        try {
            WifiManager wifi = (WifiManager) getApplicationContext().getSystemService(Context.WIFI_SERVICE);
            if (wifi != null) {
                multicastLock = wifi.createMulticastLock("nestedcanvas_multicast_lock");
                multicastLock.setReferenceCounted(true);
                multicastLock.acquire();
            }
        } catch (Exception ignored) {}

        // Đăng ký Javascript Interface để Web App lấy thẳng IP Wi-Fi của máy
        if (getBridge() != null && getBridge().getWebView() != null) {
            getBridge().getWebView().addJavascriptInterface(new AndroidNativeBridge(), "AndroidNative");
        }

        // Bắt đầu lắng nghe gói tin phát sóng từ màn hình tương tác
        startUdpDiscoveryListener();
    }

    @Override
    public void onResume() {
        super.onResume();
        if (multicastLock != null && !multicastLock.isHeld()) {
            try {
                multicastLock.acquire();
            } catch (Exception ignored) {}
        }
        injectDeviceIp();
    }

    private void injectDeviceIp() {
        runOnUiThread(() -> {
            try {
                String ip = getDeviceIp();
                if (ip != null && getBridge() != null && getBridge().getWebView() != null) {
                    getBridge().getWebView().evaluateJavascript("window.__ANDROID_LOCAL_IP__ = '" + ip + "';", null);
                }
            } catch (Exception ignored) {}
        });
    }

    private String getDeviceIp() {
        try {
            List<NetworkInterface> interfaces = Collections.list(NetworkInterface.getNetworkInterfaces());
            for (NetworkInterface intf : interfaces) {
                if (intf.isLoopback() || !intf.isUp()) continue;
                List<InetAddress> addrs = Collections.list(intf.getInetAddresses());
                for (InetAddress addr : addrs) {
                    if (!addr.isLoopbackAddress() && addr instanceof Inet4Address) {
                        return addr.getHostAddress();
                    }
                }
            }
        } catch (Exception ignored) {}
        return null;
    }

    private void startUdpDiscoveryListener() {
        isRunning = true;
        udpThread = new Thread(() -> {
            try {
                udpSocket = new DatagramSocket(null);
                udpSocket.setReuseAddress(true);
                udpSocket.setBroadcast(true);
                udpSocket.bind(new InetSocketAddress(8766));

                byte[] buffer = new byte[2048];
                while (isRunning && !Thread.currentThread().isInterrupted()) {
                    DatagramPacket packet = new DatagramPacket(buffer, buffer.length);
                    udpSocket.receive(packet);

                    String message = new String(packet.getData(), 0, packet.getLength(), StandardCharsets.UTF_8);
                    if (message.contains("nestedcanvas")) {
                        try {
                            JSONObject json = new JSONObject(message);
                            String ip = json.optString("ip", packet.getAddress().getHostAddress());
                            int port = json.optInt("port", 8765);
                            String name = json.optString("name", "Màn hình tương tác");

                            notifyWebViewServerFound(ip, port, name);
                        } catch (Exception ignored) {}
                    }
                }
            } catch (Exception ignored) {
            } finally {
                if (udpSocket != null && !udpSocket.isClosed()) {
                    udpSocket.close();
                }
            }
        });
        udpThread.setDaemon(true);
        udpThread.start();
    }

    private void notifyWebViewServerFound(String ip, int port, String name) {
        runOnUiThread(() -> {
            try {
                if (getBridge() != null && getBridge().getWebView() != null) {
                    String cleanName = name.replace("'", "\\'");
                    String js = "window.dispatchEvent(new CustomEvent('nestedcanvas:server_discovered', { detail: { ip: '" + ip + "', port: " + port + ", name: '" + cleanName + "' } }));";
                    getBridge().getWebView().evaluateJavascript(js, null);
                }
            } catch (Exception ignored) {}
        });
    }

    @Override
    public void onDestroy() {
        isRunning = false;
        if (udpSocket != null && !udpSocket.isClosed()) {
            udpSocket.close();
        }
        if (udpThread != null) {
            udpThread.interrupt();
        }
        if (multicastLock != null && multicastLock.isHeld()) {
            try {
                multicastLock.release();
            } catch (Exception ignored) {}
        }
        super.onDestroy();
    }
}
