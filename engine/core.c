/*
 * LumeOS - engine/core.c
 * Implementation of the core utility library. See engine/core.h.
 */
#define _POSIX_C_SOURCE 200809L

#include "core.h"

#include <ctype.h>
#include <errno.h>
#include <stdarg.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <sys/types.h>
#include <time.h>

/* ================================================================== */
/* Logging                                                             */
/* ================================================================== */

static lume_log_level_t g_log_level = LUME_LOG_INFO;

void lume_log_set_level(lume_log_level_t lvl) { g_log_level = lvl; }
lume_log_level_t lume_log_get_level(void) { return g_log_level; }

static const char *level_name(lume_log_level_t lvl) {
    switch (lvl) {
        case LUME_LOG_DEBUG: return "DEBUG";
        case LUME_LOG_INFO:  return "INFO ";
        case LUME_LOG_WARN:  return "WARN ";
        case LUME_LOG_ERROR: return "ERROR";
        default:             return "?????";
    }
}

void lume_log(lume_log_level_t lvl, const char *fmt, ...) {
    if (lvl < g_log_level) return;

    char ts[21];
    lume_iso8601_now(ts);

    fprintf(stderr, "[%s] [%s] ", ts, level_name(lvl));

    va_list ap;
    va_start(ap, fmt);
    vfprintf(stderr, fmt, ap);
    va_end(ap);

    fputc('\n', stderr);
    fflush(stderr);
}

/* ================================================================== */
/* Strings                                                             */
/* ================================================================== */

char *lume_strdup(const char *s) {
    if (!s) return NULL;
    size_t n = strlen(s) + 1;
    char *p = malloc(n);
    if (!p) return NULL;
    memcpy(p, s, n);
    return p;
}

char *lume_strndup(const char *s, size_t n) {
    if (!s) return NULL;
    size_t len = strnlen(s, n);
    char *p = malloc(len + 1);
    if (!p) return NULL;
    memcpy(p, s, len);
    p[len] = '\0';
    return p;
}

char *lume_trim(char *s) {
    if (!s) return NULL;
    char *p = s;
    while (*p && isspace((unsigned char)*p)) p++;
    if (p != s) memmove(s, p, strlen(p) + 1);
    size_t len = strlen(s);
    while (len > 0 && isspace((unsigned char)s[len - 1])) s[--len] = '\0';
    return s;
}

int lume_str_ieq(const char *a, const char *b) {
    if (!a || !b) return a == b;
    while (*a && *b) {
        if (tolower((unsigned char)*a) != tolower((unsigned char)*b)) return 0;
        a++; b++;
    }
    return *a == '\0' && *b == '\0';
}

int lume_starts_with(const char *s, const char *prefix) {
    if (!s || !prefix) return 0;
    size_t n = strlen(prefix);
    return strncmp(s, prefix, n) == 0;
}

int lume_ends_with(const char *s, const char *suffix) {
    if (!s || !suffix) return 0;
    size_t ls = strlen(s), lx = strlen(suffix);
    if (lx > ls) return 0;
    return strcmp(s + (ls - lx), suffix) == 0;
}

int lume_strcase_ends_with(const char *s, const char *suffix) {
    if (!s || !suffix) return 0;
    size_t ls = strlen(s), lx = strlen(suffix);
    if (lx > ls) return 0;
    return lume_str_ieq(s + (ls - lx), suffix);
}

int lume_split(const char *s, char sep, char **out, int max) {
    if (!s || !out || max <= 0) return 0;
    int count = 0;
    const char *start = s;
    for (const char *p = s;; p++) {
        if (*p == sep || *p == '\0') {
            if (count < max) {
                out[count] = lume_strndup(start, (size_t)(p - start));
            }
            count++;
            if (*p == '\0') break;
            start = p + 1;
            if (count >= max) break;
        }
    }
    return count;
}

/* ================================================================== */
/* SHA-256 (FIPS 180-4)                                                */
/* ================================================================== */

typedef struct {
    uint32_t state[8];
    uint64_t bitlen;
    uint8_t  data[64];
    uint32_t datalen;
} sha256_ctx;

#define ROTR(x, n) (((x) >> (n)) | ((x) << (32 - (n))))
#define CH(x, y, z) (((x) & (y)) ^ (~(x) & (z)))
#define MAJ(x, y, z) (((x) & (y)) ^ ((x) & (z)) ^ ((y) & (z)))
#define EP0(x) (ROTR(x, 2) ^ ROTR(x, 13) ^ ROTR(x, 22))
#define EP1(x) (ROTR(x, 6) ^ ROTR(x, 11) ^ ROTR(x, 25))
#define SIG0(x) (ROTR(x, 7) ^ ROTR(x, 18) ^ ((x) >> 3))
#define SIG1(x) (ROTR(x, 17) ^ ROTR(x, 19) ^ ((x) >> 10))

static const uint32_t K[64] = {
    0x428a2f98,0x71374491,0xb5c0fbcf,0xe9b5dba5,0x3956c25b,0x59f111f1,0x923f82a4,0xab1c5ed5,
    0xd807aa98,0x12835b01,0x243185be,0x550c7dc3,0x72be5d74,0x80deb1fe,0x9bdc06a7,0xc19bf174,
    0xe49b69c1,0xefbe4786,0x0fc19dc6,0x240ca1cc,0x2de92c6f,0x4a7484aa,0x5cb0a9dc,0x76f988da,
    0x983e5152,0xa831c66d,0xb00327c8,0xbf597fc7,0xc6e00bf3,0xd5a79147,0x06ca6351,0x14292967,
    0x27b70a85,0x2e1b2138,0x4d2c6dfc,0x53380d13,0x650a7354,0x766a0abb,0x81c2c92e,0x92722c85,
    0xa2bfe8a1,0xa81a664b,0xc24b8b70,0xc76c51a3,0xd192e819,0xd6990624,0xf40e3585,0x106aa070,
    0x19a4c116,0x1e376c08,0x2748774c,0x34b0bcb5,0x391c0cb3,0x4ed8aa4a,0x5b9cca4f,0x682e6ff3,
    0x748f82ee,0x78a5636f,0x84c87814,0x8cc70208,0x90befffa,0xa4506ceb,0xbef9a3f7,0xc67178f2
};

static void sha256_transform(sha256_ctx *ctx, const uint8_t data[64]) {
    uint32_t a, b, c, d, e, f, g, h, i, j, t1, t2, m[64];
    for (i = 0, j = 0; i < 16; ++i, j += 4)
        m[i] = ((uint32_t)data[j] << 24) | ((uint32_t)data[j+1] << 16) |
               ((uint32_t)data[j+2] << 8) | ((uint32_t)data[j+3]);
    for (; i < 64; ++i)
        m[i] = SIG1(m[i-2]) + m[i-7] + SIG0(m[i-15]) + m[i-16];

    a = ctx->state[0]; b = ctx->state[1]; c = ctx->state[2]; d = ctx->state[3];
    e = ctx->state[4]; f = ctx->state[5]; g = ctx->state[6]; h = ctx->state[7];

    for (i = 0; i < 64; ++i) {
        t1 = h + EP1(e) + CH(e, f, g) + K[i] + m[i];
        t2 = EP0(a) + MAJ(a, b, c);
        h = g; g = f; f = e; e = d + t1;
        d = c; c = b; b = a; a = t1 + t2;
    }
    ctx->state[0] += a; ctx->state[1] += b; ctx->state[2] += c; ctx->state[3] += d;
    ctx->state[4] += e; ctx->state[5] += f; ctx->state[6] += g; ctx->state[7] += h;
}

static void sha256_init(sha256_ctx *ctx) {
    ctx->datalen = 0;
    ctx->bitlen = 0;
    ctx->state[0] = 0x6a09e667; ctx->state[1] = 0xbb67ae85;
    ctx->state[2] = 0x3c6ef372; ctx->state[3] = 0xa54ff53a;
    ctx->state[4] = 0x510e527f; ctx->state[5] = 0x9b05688c;
    ctx->state[6] = 0x1f83d9ab; ctx->state[7] = 0x5be0cd19;
}

static void sha256_update(sha256_ctx *ctx, const uint8_t *data, size_t len) {
    for (size_t i = 0; i < len; ++i) {
        ctx->data[ctx->datalen++] = data[i];
        if (ctx->datalen == 64) {
            sha256_transform(ctx, ctx->data);
            ctx->bitlen += 512;
            ctx->datalen = 0;
        }
    }
}

static void sha256_final(sha256_ctx *ctx, uint8_t hash[32]) {
    uint32_t i = ctx->datalen;

    if (ctx->datalen < 56) {
        ctx->data[i++] = 0x80;
        while (i < 56) ctx->data[i++] = 0x00;
    } else {
        ctx->data[i++] = 0x80;
        while (i < 64) ctx->data[i++] = 0x00;
        sha256_transform(ctx, ctx->data);
        memset(ctx->data, 0, 56);
    }

    ctx->bitlen += (uint64_t)ctx->datalen * 8;
    ctx->data[63] = (uint8_t)(ctx->bitlen);
    ctx->data[62] = (uint8_t)(ctx->bitlen >> 8);
    ctx->data[61] = (uint8_t)(ctx->bitlen >> 16);
    ctx->data[60] = (uint8_t)(ctx->bitlen >> 24);
    ctx->data[59] = (uint8_t)(ctx->bitlen >> 32);
    ctx->data[58] = (uint8_t)(ctx->bitlen >> 40);
    ctx->data[57] = (uint8_t)(ctx->bitlen >> 48);
    ctx->data[56] = (uint8_t)(ctx->bitlen >> 56);
    sha256_transform(ctx, ctx->data);

    for (i = 0; i < 4; ++i) {
        hash[i]      = (uint8_t)((ctx->state[0] >> (24 - i * 8)) & 0xff);
        hash[i + 4]  = (uint8_t)((ctx->state[1] >> (24 - i * 8)) & 0xff);
        hash[i + 8]  = (uint8_t)((ctx->state[2] >> (24 - i * 8)) & 0xff);
        hash[i + 12] = (uint8_t)((ctx->state[3] >> (24 - i * 8)) & 0xff);
        hash[i + 16] = (uint8_t)((ctx->state[4] >> (24 - i * 8)) & 0xff);
        hash[i + 20] = (uint8_t)((ctx->state[5] >> (24 - i * 8)) & 0xff);
        hash[i + 24] = (uint8_t)((ctx->state[6] >> (24 - i * 8)) & 0xff);
        hash[i + 28] = (uint8_t)((ctx->state[7] >> (24 - i * 8)) & 0xff);
    }
}

void lume_sha256(const void *data, size_t len, uint8_t out[32]) {
    sha256_ctx ctx;
    sha256_init(&ctx);
    sha256_update(&ctx, (const uint8_t *)data, len);
    sha256_final(&ctx, out);
}

void lume_sha256_hex(const void *data, size_t len, char out[65]) {
    uint8_t digest[32];
    lume_sha256(data, len, digest);
    static const char hex[] = "0123456789abcdef";
    for (int i = 0; i < 32; ++i) {
        out[i * 2]     = hex[(digest[i] >> 4) & 0xf];
        out[i * 2 + 1] = hex[digest[i] & 0xf];
    }
    out[64] = '\0';
}

/* ================================================================== */
/* CRC32                                                               */
/* ================================================================== */

static uint32_t g_crc_table[256];
static int g_crc_ready = 0;

static void crc32_init(void) {
    for (uint32_t i = 0; i < 256; ++i) {
        uint32_t c = i;
        for (int k = 0; k < 8; ++k)
            c = (c & 1) ? (0xEDB88320u ^ (c >> 1)) : (c >> 1);
        g_crc_table[i] = c;
    }
    g_crc_ready = 1;
}

uint32_t lume_crc32(const void *data, size_t len) {
    if (!g_crc_ready) crc32_init();
    const uint8_t *p = (const uint8_t *)data;
    uint32_t crc = 0xFFFFFFFFu;
    for (size_t i = 0; i < len; ++i)
        crc = g_crc_table[(crc ^ p[i]) & 0xFF] ^ (crc >> 8);
    return crc ^ 0xFFFFFFFFu;
}

int lume_ct_equal(const void *a, const void *b, size_t n) {
    const uint8_t *x = (const uint8_t *)a;
    const uint8_t *y = (const uint8_t *)b;
    uint8_t diff = 0;
    for (size_t i = 0; i < n; ++i) diff |= (uint8_t)(x[i] ^ y[i]);
    return diff == 0;
}

/* ================================================================== */
/* Growable string buffer                                              */
/* ================================================================== */

void lume_sb_init(lume_sb_t *sb) {
    sb->cap = 256;
    sb->len = 0;
    sb->buf = malloc(sb->cap);
    if (sb->buf) sb->buf[0] = '\0';
    else sb->cap = 0;
}

void lume_sb_free(lume_sb_t *sb) {
    if (!sb) return;
    free(sb->buf);
    sb->buf = NULL;
    sb->len = sb->cap = 0;
}

void lume_sb_reset(lume_sb_t *sb) {
    sb->len = 0;
    if (sb->buf && sb->cap) sb->buf[0] = '\0';
}

static void sb_ensure(lume_sb_t *sb, size_t extra) {
    if (sb->len + extra + 1 <= sb->cap) return;
    size_t ncap = sb->cap ? sb->cap : 256;
    while (ncap < sb->len + extra + 1) ncap *= 2;
    char *nb = realloc(sb->buf, ncap);
    if (!nb) return; /* on failure we keep the old buffer */
    sb->buf = nb;
    sb->cap = ncap;
}

void lume_sb_putc(lume_sb_t *sb, char c) {
    sb_ensure(sb, 1);
    if (!sb->buf) return;
    sb->buf[sb->len++] = c;
    sb->buf[sb->len] = '\0';
}

void lume_sb_puts(lume_sb_t *sb, const char *s) {
    if (!s) return;
    size_t n = strlen(s);
    sb_ensure(sb, n);
    if (!sb->buf) return;
    memcpy(sb->buf + sb->len, s, n);
    sb->len += n;
    sb->buf[sb->len] = '\0';
}

void lume_sb_write(lume_sb_t *sb, const void *data, size_t len) {
    sb_ensure(sb, len);
    if (!sb->buf) return;
    memcpy(sb->buf + sb->len, data, len);
    sb->len += len;
    sb->buf[sb->len] = '\0';
}

void lume_sb_printf(lume_sb_t *sb, const char *fmt, ...) {
    va_list ap, ap2;
    va_start(ap, fmt);
    va_copy(ap2, ap);
    int need = vsnprintf(NULL, 0, fmt, ap);
    va_end(ap);
    if (need < 0) { va_end(ap2); return; }
    sb_ensure(sb, (size_t)need);
    if (sb->buf) {
        vsnprintf(sb->buf + sb->len, (size_t)need + 1, fmt, ap2);
        sb->len += (size_t)need;
    }
    va_end(ap2);
}

void lume_json_escape(lume_sb_t *sb, const char *s) {
    lume_sb_putc(sb, '"');
    if (s) {
        for (const unsigned char *p = (const unsigned char *)s; *p; ++p) {
            switch (*p) {
                case '"':  lume_sb_puts(sb, "\\\""); break;
                case '\\': lume_sb_puts(sb, "\\\\"); break;
                case '\b': lume_sb_puts(sb, "\\b");  break;
                case '\f': lume_sb_puts(sb, "\\f");  break;
                case '\n': lume_sb_puts(sb, "\\n");  break;
                case '\r': lume_sb_puts(sb, "\\r");  break;
                case '\t': lume_sb_puts(sb, "\\t");  break;
                default:
                    if (*p < 0x20) lume_sb_printf(sb, "\\u%04x", *p);
                    else lume_sb_putc(sb, (char)*p);
            }
        }
    }
    lume_sb_putc(sb, '"');
}

char *lume_sb_detach(lume_sb_t *sb) {
    char *out = sb->buf;
    sb->buf = NULL;
    sb->len = sb->cap = 0;
    return out;
}

/* ================================================================== */
/* JSON helpers                                                        */
/* ================================================================== */

void lume_json_open(lume_sb_t *sb) { lume_sb_putc(sb, '{'); }
void lume_json_close(lume_sb_t *sb) { lume_sb_putc(sb, '}'); }

static void json_sep(lume_sb_t *sb, const char *key, int *first) {
    if (first && *first) *first = 0;
    else lume_sb_putc(sb, ',');
    lume_json_escape(sb, key);
    lume_sb_putc(sb, ':');
}

void lume_json_kv_str(lume_sb_t *sb, const char *key, const char *val, int *first) {
    json_sep(sb, key, first);
    lume_json_escape(sb, val);
}

void lume_json_kv_int(lume_sb_t *sb, const char *key, long val, int *first) {
    json_sep(sb, key, first);
    lume_sb_printf(sb, "%ld", val);
}

void lume_json_kv_ll(lume_sb_t *sb, const char *key, long long val, int *first) {
    json_sep(sb, key, first);
    lume_sb_printf(sb, "%lld", val);
}

void lume_json_kv_double(lume_sb_t *sb, const char *key, double val, int *first) {
    json_sep(sb, key, first);
    lume_sb_printf(sb, "%.4f", val);
}

void lume_json_kv_bool(lume_sb_t *sb, const char *key, int val, int *first) {
    json_sep(sb, key, first);
    lume_sb_puts(sb, val ? "true" : "false");
}

void lume_json_kv_raw(lume_sb_t *sb, const char *key, const char *raw, int *first) {
    json_sep(sb, key, first);
    lume_sb_puts(sb, raw ? raw : "null");
}

/* ================================================================== */
/* MIME types                                                          */
/* ================================================================== */

const char *lume_mime_type(const char *path) {
    static const struct { const char *ext; const char *type; } table[] = {
        { ".html", "text/html; charset=utf-8" },
        { ".htm",  "text/html; charset=utf-8" },
        { ".css",  "text/css; charset=utf-8" },
        { ".js",   "text/javascript; charset=utf-8" },
        { ".mjs",  "text/javascript; charset=utf-8" },
        { ".json", "application/json; charset=utf-8" },
        { ".map",  "application/json; charset=utf-8" },
        { ".wasm", "application/wasm" },
        { ".svg",  "image/svg+xml" },
        { ".png",  "image/png" },
        { ".jpg",  "image/jpeg" },
        { ".jpeg", "image/jpeg" },
        { ".gif",  "image/gif" },
        { ".webp", "image/webp" },
        { ".ico",  "image/x-icon" },
        { ".woff", "font/woff" },
        { ".woff2","font/woff2" },
        { ".ttf",  "font/ttf" },
        { ".txt",  "text/plain; charset=utf-8" },
        { ".md",   "text/markdown; charset=utf-8" },
        { ".xml",  "application/xml" },
        { ".pdf",  "application/pdf" },
        { ".zip",  "application/zip" },
        { ".gz",   "application/gzip" },
        { ".gguf", "application/octet-stream" },
        { ".onnx", "application/octet-stream" },
        { ".bin",  "application/octet-stream" },
        { ".lume", "application/zip" },
    };
    if (!path) return "application/octet-stream";
    for (size_t i = 0; i < sizeof(table) / sizeof(table[0]); ++i)
        if (lume_strcase_ends_with(path, table[i].ext))
            return table[i].type;
    return "application/octet-stream";
}

/* ================================================================== */
/* Portable file helpers                                               */
/* ================================================================== */

int lume_path_exists(const char *path) {
    struct stat st;
    return path && stat(path, &st) == 0;
}

int lume_is_dir(const char *path) {
    struct stat st;
    if (!path || stat(path, &st) != 0) return 0;
    return S_ISDIR(st.st_mode);
}

int lume_mkdir_p(const char *path) {
    if (!path || !*path) return -1;
    char *tmp = lume_strdup(path);
    if (!tmp) return -1;
    size_t len = strlen(tmp);
    while (len > 1 && tmp[len - 1] == '/') tmp[--len] = '\0';

    for (char *p = tmp + 1; *p; ++p) {
        if (*p == '/') {
            *p = '\0';
            if (mkdir(tmp, 0755) != 0 && errno != EEXIST) {
                free(tmp);
                return -1;
            }
            *p = '/';
        }
    }
    int rc = 0;
    if (mkdir(tmp, 0755) != 0 && errno != EEXIST) rc = -1;
    free(tmp);
    return rc;
}

int lume_file_read(const char *path, char **out, size_t *out_len) {
    if (!path || !out) return -1;
    FILE *f = fopen(path, "rb");
    if (!f) return -1;

    if (fseek(f, 0, SEEK_END) != 0) { fclose(f); return -1; }
    long sz = ftell(f);
    if (sz < 0) { fclose(f); return -1; }
    rewind(f);

    char *buf = malloc((size_t)sz + 1);
    if (!buf) { fclose(f); return -1; }

    size_t rd = fread(buf, 1, (size_t)sz, f);
    fclose(f);
    buf[rd] = '\0';
    *out = buf;
    if (out_len) *out_len = rd;
    return 0;
}

int lume_file_write(const char *path, const void *data, size_t len) {
    if (!path) return -1;
    FILE *f = fopen(path, "wb");
    if (!f) return -1;
    size_t wr = len ? fwrite(data, 1, len, f) : 0;
    int rc = (wr == len) ? 0 : -1;
    if (fclose(f) != 0) rc = -1;
    return rc;
}

char *lume_path_join(const char *a, const char *b) {
    if (!a) return lume_strdup(b ? b : "");
    if (!b) return lume_strdup(a);
    size_t la = strlen(a), lb = strlen(b);
    int sep = (la > 0 && a[la - 1] != '/') ? 1 : 0;
    char *out = malloc(la + (size_t)sep + lb + 1);
    if (!out) return NULL;
    memcpy(out, a, la);
    if (sep) out[la] = '/';
    memcpy(out + la + sep, b, lb + 1);
    return out;
}

const char *lume_basename(const char *path) {
    if (!path) return "";
    const char *slash = strrchr(path, '/');
    return slash ? slash + 1 : path;
}

/* ================================================================== */
/* Time                                                                */
/* ================================================================== */

void lume_iso8601_now(char out[21]) {
    time_t now = time(NULL);
    struct tm tm_utc;
#if defined(_WIN32)
    gmtime_s(&tm_utc, &now);
#else
    gmtime_r(&now, &tm_utc);
#endif
    strftime(out, 21, "%Y-%m-%dT%H:%M:%SZ", &tm_utc);
}
