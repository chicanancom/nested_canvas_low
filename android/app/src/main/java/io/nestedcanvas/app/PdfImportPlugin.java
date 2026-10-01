package io.nestedcanvas.app;

import android.app.Activity;
import android.content.Intent;
import android.database.Cursor;
import android.graphics.Bitmap;
import android.graphics.Color;
import android.graphics.pdf.PdfRenderer;
import android.net.Uri;
import android.os.ParcelFileDescriptor;
import android.provider.OpenableColumns;
import android.util.Base64;
import androidx.activity.result.ActivityResult;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.ActivityCallback;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileOutputStream;
import java.io.FileInputStream;
import java.io.InputStream;
import java.util.UUID;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

@CapacitorPlugin(name = "PdfImport")
public class PdfImportPlugin extends Plugin {
    private static final long MAX_BYTES = 25L * 1024 * 1024;
    private final ExecutorService worker = Executors.newSingleThreadExecutor();
    private File document;
    private String token;

    @PluginMethod
    public void pick(PluginCall call) {
        Intent intent = new Intent(Intent.ACTION_OPEN_DOCUMENT);
        intent.addCategory(Intent.CATEGORY_OPENABLE);
        intent.setType("application/pdf");
        intent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
        try {
            startActivityForResult(call, intent, "picked");
        } catch (Exception error) {
            call.reject("Không mở được trình chọn PDF trên thiết bị.", error);
        }
    }

    @ActivityCallback
    private void picked(PluginCall call, ActivityResult result) {
        if (call == null) return;
        if (result.getResultCode() != Activity.RESULT_OK || result.getData() == null || result.getData().getData() == null) {
            JSObject cancelled = new JSObject();
            cancelled.put("cancelled", true);
            call.resolve(cancelled);
            return;
        }
        Uri uri = result.getData().getData();
        worker.execute(() -> {
            clearDocument();
            try {
                String name = "PDF.pdf";
                try (Cursor cursor = getContext().getContentResolver().query(uri, new String[]{OpenableColumns.DISPLAY_NAME}, null, null, null)) {
                    if (cursor != null && cursor.moveToFirst()) name = cursor.getString(0);
                }
                document = File.createTempFile("nestedcanvas-pdf-", ".pdf", getContext().getCacheDir());
                try (InputStream input = getContext().getContentResolver().openInputStream(uri);
                     FileOutputStream output = new FileOutputStream(document)) {
                    if (input == null) throw new Exception("Không đọc được tệp PDF.");
                    byte[] buffer = new byte[8192];
                    long total = 0;
                    int count;
                    while ((count = input.read(buffer)) != -1) {
                        total += count;
                        if (total > MAX_BYTES) throw new Exception("PDF vượt quá 25 MB. Hãy chia tệp thành các phần nhỏ hơn.");
                        output.write(buffer, 0, count);
                    }
                }
                int pages;
                try (ParcelFileDescriptor descriptor = ParcelFileDescriptor.open(document, ParcelFileDescriptor.MODE_READ_ONLY);
                     PdfRenderer renderer = new PdfRenderer(descriptor)) {
                    pages = renderer.getPageCount();
                }
                if (pages < 1) throw new Exception("PDF không có trang nào.");
                token = UUID.randomUUID().toString();
                JSObject data = new JSObject();
                data.put("token", token);
                data.put("name", name);
                data.put("pageCount", pages);
                try (FileInputStream input = new FileInputStream(document);
                     ByteArrayOutputStream bytes = new ByteArrayOutputStream()) {
                    byte[] buffer = new byte[8192];
                    int count;
                    while ((count = input.read(buffer)) != -1) bytes.write(buffer, 0, count);
                    data.put("source", Base64.encodeToString(bytes.toByteArray(), Base64.NO_WRAP));
                }
                call.resolve(data);
            } catch (Exception error) {
                clearDocument();
                call.reject("Không đọc được PDF: " + error.getMessage(), error);
            }
        });
    }

    @PluginMethod
    public void renderPage(PluginCall call) {
        worker.execute(() -> {
            File temporary = null;
            try {
                File file = document;
                String source = call.getString("source");
                if (source != null) {
                    if (source.length() > (MAX_BYTES + 2) / 3 * 4) throw new Exception("PDF vượt quá 25 MB.");
                    byte[] bytes = Base64.decode(source, Base64.DEFAULT);
                    if (bytes.length > MAX_BYTES) throw new Exception("PDF vượt quá 25 MB.");
                    temporary = File.createTempFile("nestedcanvas-pdf-page-", ".pdf", getContext().getCacheDir());
                    try (FileOutputStream output = new FileOutputStream(temporary)) { output.write(bytes); }
                    file = temporary;
                } else if (document == null || token == null || !token.equals(call.getString("token"))) {
                    throw new Exception("Tệp PDF không còn mở.");
                }
                try (ParcelFileDescriptor descriptor = ParcelFileDescriptor.open(file, ParcelFileDescriptor.MODE_READ_ONLY);
                 PdfRenderer renderer = new PdfRenderer(descriptor)) {
                Integer index = call.getInt("pageIndex");
                if (index == null || index < 0 || index >= renderer.getPageCount()) throw new Exception("Trang PDF không hợp lệ.");
                try (PdfRenderer.Page page = renderer.openPage(index)) {
                    double scale = Math.min(2.0, 1600.0 / Math.max(page.getWidth(), page.getHeight()));
                    int width = Math.max(1, (int) Math.floor(page.getWidth() * scale));
                    int height = Math.max(1, (int) Math.floor(page.getHeight() * scale));
                    Bitmap bitmap = Bitmap.createBitmap(width, height, Bitmap.Config.ARGB_8888);
                    try (ByteArrayOutputStream output = new ByteArrayOutputStream()) {
                        bitmap.eraseColor(Color.WHITE);
                        page.render(bitmap, null, null, PdfRenderer.Page.RENDER_MODE_FOR_DISPLAY);
                        if (!bitmap.compress(Bitmap.CompressFormat.JPEG, 82, output)) throw new Exception("Không tạo được ảnh trang PDF.");
                        JSObject data = new JSObject();
                        data.put("src", "data:image/jpeg;base64," + Base64.encodeToString(output.toByteArray(), Base64.NO_WRAP));
                        data.put("width", width);
                        data.put("height", height);
                        call.resolve(data);
                    } finally {
                        bitmap.recycle();
                    }
                }
                }
            } catch (Exception error) {
                call.reject("Không dựng được trang PDF: " + error.getMessage(), error);
            } finally {
                if (temporary != null) temporary.delete();
            }
        });
    }

    @PluginMethod
    public void release(PluginCall call) {
        worker.execute(() -> {
            if (token != null && token.equals(call.getString("token"))) clearDocument();
            call.resolve();
        });
    }

    private void clearDocument() {
        if (document != null) document.delete();
        document = null;
        token = null;
    }

    @Override
    protected void handleOnDestroy() {
        worker.execute(this::clearDocument);
        worker.shutdown();
    }
}
