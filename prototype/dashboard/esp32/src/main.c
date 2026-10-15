/* PROTOTYPE — throwaway (issue #7). Not firmware for the car, not production.
 *
 * The ESP32-S3 half of the dashboard prototype: an access point serving the
 * same dashboard page the laptop prototype serves, with the fake drive
 * generated on the board instead of in Node. It exists to answer the one part
 * of issue #7 a laptop cannot: does an access point plus a browser live view
 * hold up on the real chip, and what does it cost in RAM.
 *
 * There is no car, no OBD2 port and no record model here. The device has no
 * records to export — that is ticket #4 — so the ledger and the export sheet
 * show nothing and say so. The live path is the whole point.
 *
 * The page is not modified for the device: index.html, style.css and app.js are
 * the laptop prototype's files, embedded verbatim by tools/embed.mjs.
 */
#include <stdio.h>
#include <string.h>
#include <math.h>
#include <stdlib.h>

#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "freertos/semphr.h"
#include "esp_log.h"
#include "esp_timer.h"
#include "esp_heap_caps.h"
#include "esp_wifi.h"
#include "esp_event.h"
#include "esp_netif.h"
#include "esp_http_server.h"
#include "nvs_flash.h"

#include "web_assets.h"

static const char *TAG = "dash";

#ifndef APP_HZ
#define APP_HZ 10
#endif
#ifndef APP_SSID
#define APP_SSID "camry-telemetry"
#endif
#ifndef APP_PASS
#define APP_PASS "telemetry1234"
#endif

#define CASE_BATCH_URL "https://telemetry.example.invalid/api/v1/batches"
#define ROLLUP_SEC 60      /* the prototype's compressed stand-in for the 5-minute rollup */
#define WINDOW_SEC 300     /* the ignition-off export window */
#define MAX_CLIENTS 4      /* four phones; see the finding on #7 for the socket budget */

// ---------------------------------------------------------------- fake drive
// The same six-phase shape the laptop prototype cycles through, so the traces
// on the phone look like the ones this page was designed against.
typedef struct { const char *name; int sec; float from, to; int eng; int rpm; } phase_t;
static const phase_t PHASES[] = {
    { "ev creep",    12,   0,  18, 0,    0 },
    { "launch",      10,  18,  60, 1, 2200 },
    { "city",        28,  35,  55, 2, 1500 },   /* eng 2 = the engine cycles on its own */
    { "highway",     30, 100, 112, 1, 1900 },
    { "regen brake", 10, 100,  12, 0,    0 },
    { "idle charge", 14,   0,   0, 1, 1250 },
};
#define PHASE_COUNT (sizeof(PHASES) / sizeof(PHASES[0]))
#define CYCLE_MS 104000

typedef struct {
    uint32_t seq;
    int64_t  base_ms;        /* device clock = base_ms + uptime */
    int      clock_set;
    int      ignoff;         /* ignition-off window is open */
    float    window_left;
    int      uploading;

    float speed, soc, hv_v, hv_a, pwr, km, ev_km, max_kph, odo;
    int   rpm, eng, coolant, load, amb, eng_on_s, moving_s, idle_s;
    const char *phase, *es;
} state_t;

static state_t st;
static volatile int hz = APP_HZ;

static int64_t uptime_ms(void) { return esp_timer_get_time() / 1000; }
/* A board with no RTC and no route to NTP knows exactly one time: when it was
 * flashed. That is what it reports until a browser hands it a real clock. */
static int64_t dev_now(void) { return st.base_ms + uptime_ms(); }

static void simulate(void)
{
    // wall clock, so a dropped sample never changes the shape of the drive
    uint32_t p = (uint32_t)(uptime_ms() % CYCLE_MS);
    float secf = p / 1000.0f;
    const phase_t *ph = PHASES;
    int acc = 0;
    for (int i = 0; i < (int)PHASE_COUNT; i++) {
        if (secf < acc + PHASES[i].sec) { ph = &PHASES[i]; break; }
        acc += PHASES[i].sec;
    }
    float f = (secf - acc) / (float)ph->sec;
    st.phase = ph->name;

    st.speed = ph->from + (ph->to - ph->from) * f + sinf(secf * 1.7f) * 1.2f;
    if (st.speed < 0) st.speed = 0;
    st.eng = ph->eng == 2 ? fmodf(secf, 9.0f) < 6.0f : ph->eng;
    st.rpm = st.eng ? ph->rpm + (int)(sinf(secf * 3.1f) * 60) : 0;

    st.coolant = 88 + (int)(sinf(secf * 0.3f) * 2);
    st.load = st.eng ? 28 + (int)(fabsf(sinf(secf * 1.1f)) * 45) : 0;
    st.amb = 24;

    st.hv_v = 210.0f + sinf(secf * 0.2f) * 6.0f;
    st.hv_a = st.eng ? (st.speed < 1 ? 12.0f : 8.0f) : (st.speed > 1 ? -26.0f : -1.5f);
    st.pwr = st.hv_v * st.hv_a / 1000.0f;
    st.soc = 58.0f + sinf(secf * 0.12f) * 6.0f;

    // engine spinning is not engine running, so the state word is derived from
    // both: off is off, and regen needs the engine off *and* current flowing in
    st.es = st.speed < 1 ? (st.eng ? "IDLE" : "OFF")
          : (!st.eng && st.hv_a < -6 ? "REGEN" : (st.eng ? "ENGINE" : "EV"));

    float dt = 1.0f / hz;
    st.km += st.speed * dt / 3600.0f;
    if (!st.eng) st.ev_km += st.speed * dt / 3600.0f;
    if (st.speed > 2) st.moving_s += dt; else st.idle_s += dt;
    if (st.eng) st.eng_on_s += dt;
    if (st.speed > st.max_kph) st.max_kph = st.speed;
    st.odo = 41234.5f + st.km;
    st.seq++;
}

static int msg_json(char *b, size_t n)
{
    int64_t now = dev_now();
    return snprintf(b, n,
        "{\"type\":\"t\",\"seq\":%u,\"t\":%lld,\"host\":%lld,\"ck\":%d,\"sp\":%.1f,\"rpm\":%d,\"eng\":%d,\"es\":\"%s\","
        "\"soc\":%.1f,\"hvV\":%.1f,\"hvA\":%.1f,\"pwr\":%.1f,\"cool\":%d,\"load\":%d,\"amb\":%d,"
        "\"km\":%.2f,\"odo\":%.1f,\"run\":%d,\"mov\":%d,\"idle\":%d,\"evKm\":%.2f,\"maxKph\":%.1f,"
        "\"ph\":\"%s\",\"home\":%d}",
        (unsigned)st.seq, (long long)now, (long long)now, st.clock_set,
        (double)st.speed, st.rpm, st.eng, st.es,
        (double)st.soc, (double)st.hv_v, (double)st.hv_a, (double)st.pwr,
        st.coolant, st.load, st.amb,
        (double)st.km, (double)st.odo, st.eng_on_s, st.moving_s, st.idle_s,
        (double)st.ev_km, (double)st.max_kph, st.phase, st.ignoff);
}

// ---------------------------------------------------------------- clients
/* Only the tick task writes to a client once it is registered, so one lock is
 * enough: the httpd task registers, the tick task sends and unregisters. */
typedef struct { httpd_req_t *req; int64_t last_ok; int sent; } client_t;
static client_t clients[MAX_CLIENTS];
static int64_t poll_last_ok;      /* the page's silent snapshot poll is not a client; a poll channel is */
static SemaphoreHandle_t clients_lock;

static int clients_connected(int64_t now)
{
    int n = 0;
    for (int i = 0; i < MAX_CLIENTS; i++)
        if (clients[i].req && now - clients[i].last_ok < 15000) n++;
    if (now - poll_last_ok < 15000) n++;
    return n;
}

/* Returns how many clients took the frame. A client that cannot take it is
 * dropped and its socket closed rather than queued — the same rule the device
 * must follow for any slow or vanished phone. */
static int broadcast(const char *frame, int len, int64_t now)
{
    int n = 0;
    xSemaphoreTake(clients_lock, portMAX_DELAY);
    for (int i = 0; i < MAX_CLIENTS; i++) {
        if (!clients[i].req) continue;
        esp_err_t err = httpd_resp_send_chunk(clients[i].req, frame, len);
        if (err != ESP_OK) {
            ESP_LOGW(TAG, "client %d dropped after %d frames (%s)", i, clients[i].sent, esp_err_to_name(err));
            httpd_req_async_handler_complete(clients[i].req);
            clients[i].req = NULL;
            continue;
        }
        clients[i].sent++;
        clients[i].last_ok = now;
        n++;
    }
    xSemaphoreGive(clients_lock);
    return n;
}

static void log_heap(const char *when)
{
    ESP_LOGI(TAG, "%-26s free=%u  internal=%u  largest_internal=%u", when,
             (unsigned)esp_get_free_heap_size(),
             (unsigned)heap_caps_get_free_size(MALLOC_CAP_INTERNAL),
             (unsigned)heap_caps_get_largest_free_block(MALLOC_CAP_INTERNAL));
}

// ---------------------------------------------------------------- http
static esp_err_t send_asset(httpd_req_t *req, const char *body, const char *mime)
{
    httpd_resp_set_type(req, mime);
    httpd_resp_set_hdr(req, "Cache-Control", "no-store");
    return httpd_resp_send(req, body, HTTPD_RESP_USE_STRLEN);
}

static int snapshot_json(char *b, size_t n)
{
    int64_t now = uptime_ms();
    int suspended = (st.ignoff && clients_connected(now)) || st.uploading;
    return snprintf(b, n,
        "{\"awake\":1,\"sleeping\":0,\"ignitionOffAt\":%s,\"skewMs\":0,\"clockSet\":%d,"
        "\"windowLeft\":%d,\"suspended\":%d,\"uploading\":%d,\"rollupSec\":%d,\"phase\":\"%s\","
        "\"current\":null,\"trips\":[],\"rollups\":[],\"events\":[],\"deleted\":0,"
        "\"batchUrl\":\"" CASE_BATCH_URL "\"}",
        st.ignoff ? "1" : "null", st.clock_set, (int)st.window_left, suspended,
        st.uploading, ROLLUP_SEC, st.phase);
}

static esp_err_t snapshot_get(httpd_req_t *req)
{
    char b[512];
    snapshot_json(b, sizeof b);
    httpd_resp_set_type(req, "application/json");
    httpd_resp_set_hdr(req, "Cache-Control", "no-store");
    return httpd_resp_send(req, b, HTTPD_RESP_USE_STRLEN);
}

/* The polling channel and the state poll both land here. Polling counts as a
 * connected client; the page's own silent /api/snapshot poll does not — the
 * same distinction the laptop prototype needed. */
static esp_err_t latest_get(httpd_req_t *req)
{
    char b[640];
    poll_last_ok = uptime_ms();   /* a polling phone owns no socket, so presence is a timestamp */
    msg_json(b, sizeof b);
    httpd_resp_set_type(req, "application/json");
    httpd_resp_set_hdr(req, "Cache-Control", "no-store");
    return httpd_resp_send(req, b, HTTPD_RESP_USE_STRLEN);
}

static esp_err_t body_read(httpd_req_t *req, char *b, size_t n)
{
    int len = req->content_len < (int)n - 1 ? req->content_len : (int)n - 1;
    int got = httpd_req_recv(req, b, len);
    if (got <= 0) { b[0] = 0; return ESP_FAIL; }
    while (got < len) {                       /* a body can arrive in pieces */
        int more = httpd_req_recv(req, b + got, len - got);
        if (more <= 0) break;
        got += more;
    }
    b[got] = 0;
    return ESP_OK;
}

static long body_number(const char *b, const char *key)
{
    const char *p = strstr(b, key);
    return p ? strtol(p + strlen(key), NULL, 10) : 0;
}

static esp_err_t stream_get(httpd_req_t *req)
{
    httpd_resp_set_type(req, "text/event-stream");
    httpd_resp_set_hdr(req, "Cache-Control", "no-cache");

    /* The handler returns immediately and the socket lives on, so the httpd
     * task is never parked on a phone. Sending happens from the tick task, and
     * httpd's own send timeout is what stops a vanished phone from stalling it. */
    xSemaphoreTake(clients_lock, portMAX_DELAY);
    int slot = -1;
    for (int i = 0; i < MAX_CLIENTS; i++) if (!clients[i].req && slot < 0) slot = i;
    httpd_req_t *areq = NULL;
    if (slot < 0 || httpd_req_async_handler_begin(req, &areq) != ESP_OK) {
        xSemaphoreGive(clients_lock);
        ESP_LOGW(TAG, "sse refused: %s", slot < 0 ? "no free client slot" : "async handler failed");
        return httpd_resp_send_err(req, HTTPD_500_INTERNAL_SERVER_ERROR, "no free client slot");
    }
    clients[slot].req = areq;
    clients[slot].last_ok = uptime_ms();
    clients[slot].sent = 0;
    xSemaphoreGive(clients_lock);

    const char *hello = "retry: 1500\n\nevent: hello\ndata: {\"type\":\"hello\",\"hz\":";
    char hbuf[160];
    int n = snprintf(hbuf, sizeof hbuf, "%s%d,\"rollupSec\":%d,\"windowSec\":%d}\n\n", hello, hz, ROLLUP_SEC, WINDOW_SEC);
    if (httpd_resp_send_chunk(areq, hbuf, n) != ESP_OK) {
        xSemaphoreTake(clients_lock, portMAX_DELAY);
        if (clients[slot].req == areq) clients[slot].req = NULL;
        xSemaphoreGive(clients_lock);
        httpd_req_async_handler_complete(areq);
        return ESP_FAIL;
    }
    ESP_LOGI(TAG, "sse client %d attached (slot %d, heap %u)", clients_connected(uptime_ms()), slot,
             (unsigned)heap_caps_get_free_size(MALLOC_CAP_INTERNAL));
    return ESP_OK;
}

static esp_err_t rate_post(httpd_req_t *req)
{
    char b[64];
    body_read(req, b, sizeof b);
    long h = body_number(b, "hz");
    if (h >= 1 && h <= 20) hz = (int)h;
    char out[32];
    int n = snprintf(out, sizeof out, "{\"hz\":%d}", hz);
    httpd_resp_set_type(req, "application/json");
    return httpd_resp_send(req, out, n);
}

static esp_err_t settime_post(httpd_req_t *req)
{
    char b[64];
    body_read(req, b, sizeof b);
    const char *p = strstr(b, "time");
    if (p) {
        long long t = strtoll(p + 4, NULL, 10);
        if (t > 0) { st.base_ms = t - uptime_ms(); st.clock_set = 1; }
    }
    ESP_LOGI(TAG, "clock %s", st.clock_set ? "set by a browser" : "unchanged");
    return snapshot_get(req);
}

static esp_err_t ignoff_post(httpd_req_t *req)
{
    if (!st.ignoff) {
        st.ignoff = 1;
        st.window_left = WINDOW_SEC;
        ESP_LOGI(TAG, "ignition off — %d s window, and it only counts while nothing is connected", WINDOW_SEC);
    }
    return snapshot_get(req);
}

static esp_err_t wake_post(httpd_req_t *req)
{
    memset(&st, 0, sizeof st);
    st.base_ms = BUILD_EPOCH_MS;      /* a reboot loses the clock again: no RTC, no NTP */
    st.phase = PHASES[0].name;
    st.es = "OFF";
    ESP_LOGI(TAG, "woke on CAN activity, clock lost");
    return snapshot_get(req);
}

static esp_err_t uploading_post(httpd_req_t *req)
{
    char b[64];
    body_read(req, b, sizeof b);
    st.uploading = strstr(b, "true") != NULL;
    return snapshot_get(req);
}

/* The device has no records yet — derivation is ticket #4 — so a confirmed
 * export deletes nothing and says so. */
static esp_err_t delete_post(httpd_req_t *req)
{
    st.uploading = 0;
    return snapshot_get(req);
}

static esp_err_t index_get(httpd_req_t *req) { return send_asset(req, INDEX_HTML, INDEX_HTML_MIME); }
static esp_err_t css_get(httpd_req_t *req)   { return send_asset(req, STYLE_CSS, STYLE_CSS_MIME); }
static esp_err_t js_get(httpd_req_t *req)    { return send_asset(req, APP_JS, APP_JS_MIME); }

static void http_start(void)
{
    httpd_config_t cfg = HTTPD_DEFAULT_CONFIG();
    cfg.max_uri_handlers = 16;     /* 12 routes below; the default 8 fails silently */
    cfg.max_open_sockets = 7;      /* 3 are reserved by httpd, so 4 phones */
    cfg.lru_purge_enable = true;   /* full: close the least recently used, never queue */
    cfg.send_wait_timeout = 3;     /* a vanished phone must not park the tick task */
    cfg.recv_wait_timeout = 5;
    cfg.stack_size = 8192;
    /* exact-path matching: a wildcard matcher would let "/" swallow every route */

    httpd_handle_t server = NULL;
    ESP_ERROR_CHECK(httpd_start(&server, &cfg));

    const httpd_uri_t uris[] = {
        { "/",                 HTTP_GET,  index_get,     NULL },
        { "/style.css",        HTTP_GET,  css_get,       NULL },
        { "/app.js",           HTTP_GET,  js_get,        NULL },
        { "/api/snapshot",     HTTP_GET,  snapshot_get,  NULL },
        { "/api/latest",       HTTP_GET,  latest_get,    NULL },
        { "/api/stream",       HTTP_GET,  stream_get,    NULL },
        { "/api/rate",         HTTP_POST, rate_post,     NULL },
        { "/api/settime",      HTTP_POST, settime_post,  NULL },
        { "/api/ignition-off", HTTP_POST, ignoff_post,   NULL },
        { "/api/wake",         HTTP_POST, wake_post,     NULL },
        { "/api/uploading",    HTTP_POST, uploading_post,NULL },
        { "/api/delete",       HTTP_POST, delete_post,   NULL },
    };
    for (size_t i = 0; i < sizeof(uris) / sizeof(uris[0]); i++)
        ESP_ERROR_CHECK(httpd_register_uri_handler(server, &uris[i]));
    log_heap("http server up");
}

// ---------------------------------------------------------------- wifi
static void on_wifi(void *arg, esp_event_base_t base, int32_t id, void *data)
{
    if (id == WIFI_EVENT_AP_STACONNECTED) {
        log_heap("phone joined the AP");
    } else if (id == WIFI_EVENT_AP_STADISCONNECTED) {
        log_heap("phone left the AP");
    }
}

static void wifi_start(void)
{
    ESP_ERROR_CHECK(esp_netif_init());
    ESP_ERROR_CHECK(esp_event_loop_create_default());
    esp_netif_create_default_wifi_ap();

    wifi_init_config_t init = WIFI_INIT_CONFIG_DEFAULT();
    ESP_ERROR_CHECK(esp_wifi_init(&init));
    ESP_ERROR_CHECK(esp_event_handler_instance_register(WIFI_EVENT, ESP_EVENT_ANY_ID, on_wifi, NULL, NULL));

    wifi_config_t wc = {
        .ap = {
            .ssid = APP_SSID,
            .password = APP_PASS,
            .ssid_len = strlen(APP_SSID),
            .channel = 1,
            .max_connection = MAX_CLIENTS,
            .authmode = WIFI_AUTH_WPA2_PSK,
            .pmf_cfg = { .required = false },
        },
    };
    ESP_ERROR_CHECK(esp_wifi_set_mode(WIFI_MODE_AP));
    ESP_ERROR_CHECK(esp_wifi_set_config(WIFI_IF_AP, &wc));
    ESP_ERROR_CHECK(esp_wifi_start());

    esp_netif_t *ap = esp_netif_get_handle_from_ifkey("WIFI_AP_DEF");
    esp_netif_ip_info_t ip;
    if (ap && esp_netif_get_ip_info(ap, &ip) == ESP_OK) {
        ESP_LOGI(TAG, "AP \"%s\" up on %d.%d.%d.%d — open http://%d.%d.%d.%d/ on the phone",
                 APP_SSID, IP2STR(&ip.ip), IP2STR(&ip.ip));
    }
    log_heap("wifi AP up");
}

// ---------------------------------------------------------------- tick
static void tick_task(void *arg)
{
    char msg[640], frame[768];
    int64_t last_log = 0;

    for (;;) {
        simulate();
        msg_json(msg, sizeof msg);
        int flen = snprintf(frame, sizeof frame, "id: %u\ndata: %s\n\n", (unsigned)st.seq, msg);
        int64_t now = uptime_ms();

        if (flen > 0 && flen < (int)sizeof frame) {
            int sent = broadcast(frame, flen, now);
            if (st.ignoff && st.window_left > 0) {
                // the window only runs while nothing is connected: a phone
                // watching it would otherwise hold the device awake forever
                float dt = 1.0f / hz;
                if (clients_connected(now) == 0 && !st.uploading) st.window_left -= dt;
                if (st.window_left <= 0) { st.window_left = 0; ESP_LOGI(TAG, "export window expired"); }
            }
            if (now - last_log > 4000) {
                last_log = now;
                ESP_LOGI(TAG, "up %llds  seq=%u  %s  %.1f km/h  %s  took=%d/%d  heap_int=%u",
                         (long long)(now / 1000), (unsigned)st.seq, st.phase, (double)st.speed, st.es,
                         sent, clients_connected(now),
                         (unsigned)heap_caps_get_free_size(MALLOC_CAP_INTERNAL));
            }
        }
        vTaskDelay(pdMS_TO_TICKS(1000 / hz));
    }
}

// ---------------------------------------------------------------- main
void app_main(void)
{
    esp_err_t err = nvs_flash_init();
    if (err == ESP_ERR_NVS_NO_FREE_PAGES || err == ESP_ERR_NVS_NEW_VERSION_FOUND) {
        ESP_ERROR_CHECK(nvs_flash_erase());
        ESP_ERROR_CHECK(nvs_flash_init());
    }
    ESP_ERROR_CHECK(err);

    st.base_ms = BUILD_EPOCH_MS;
    st.phase = PHASES[0].name;
    st.es = "OFF";
    clients_lock = xSemaphoreCreateMutex();
    configASSERT(clients_lock);

    log_heap("boot");
    wifi_start();
    http_start();
    xTaskCreate(tick_task, "tick", 4096, NULL, 5, NULL);

    ESP_LOGI(TAG, "tell the page: the clock is the flash time until a browser syncs it");
}
