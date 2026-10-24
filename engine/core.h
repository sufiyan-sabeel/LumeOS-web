/*
 * LumeOS - engine/core.h
 * Core OS logic and low-level utility library.
 *
 * Provides logging, string utilities, integrity hashing (SHA-256 / CRC32),
 * a growable string buffer, minimal JSON serialization helpers, MIME type
 * resolution and portable file helpers. This module is dependency-free and
 * is shared by both the HTTP server (backend/) and the core engine.
 */
#ifndef LUME_CORE_H
#define LUME_CORE_H

#include <stddef.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

#define LUME_VERSION "1.0.0"

/* ------------------------------------------------------------------ */
/* Logging                                                             */
/* ------------------------------------------------------------------ */
typedef enum {
    LUME_LOG_DEBUG = 0,
    LUME_LOG_INFO  = 1,
    LUME_LOG_WARN  = 2,
    LUME_LOG_ERROR = 3
} lume_log_level_t;

void lume_log_set_level(lume_log_level_t lvl);
lume_log_level_t lume_log_get_level(void);
void lume_log(lume_log_level_t lvl, const char *fmt, ...);

#define LOG_DEBUG(...) lume_log(LUME_LOG_DEBUG, __VA_ARGS__)
#define LOG_INFO(...)  lume_log(LUME_LOG_INFO,  __VA_ARGS__)
#define LOG_WARN(...)  lume_log(LUME_LOG_WARN,  __VA_ARGS__)
#define LOG_ERROR(...) lume_log(LUME_LOG_ERROR, __VA_ARGS__)

/* ------------------------------------------------------------------ */
/* Strings                                                             */
/* ------------------------------------------------------------------ */
char *lume_strdup(const char *s);
char *lume_strndup(const char *s, size_t n);
char *lume_trim(char *s);                 /* trims in place, returns s */
int   lume_str_ieq(const char *a, const char *b);
int   lume_starts_with(const char *s, const char *prefix);
int   lume_ends_with(const char *s, const char *suffix);
int   lume_strcase_ends_with(const char *s, const char *suffix);
/* Splits `s` on `sep` into at most `max` NUL-terminated tokens.
 * Returns token count. Tokens are heap-allocated (caller frees each). */
int   lume_split(const char *s, char sep, char **out, int max);

/* ------------------------------------------------------------------ */
/* Integrity hashing                                                   */
/* ------------------------------------------------------------------ */
void     lume_sha256(const void *data, size_t len, uint8_t out[32]);
void     lume_sha256_hex(const void *data, size_t len, char out[65]);
uint32_t lume_crc32(const void *data, size_t len);
/* Constant-time comparison; returns 1 if equal. */
int      lume_ct_equal(const void *a, const void *b, size_t n);

/* ------------------------------------------------------------------ */
/* Growable string buffer                                              */
/* ------------------------------------------------------------------ */
typedef struct {
    char  *buf;
    size_t len;
    size_t cap;
} lume_sb_t;

void  lume_sb_init(lume_sb_t *sb);
void  lume_sb_free(lume_sb_t *sb);
void  lume_sb_reset(lume_sb_t *sb);
void  lume_sb_putc(lume_sb_t *sb, char c);
void  lume_sb_puts(lume_sb_t *sb, const char *s);
void  lume_sb_write(lume_sb_t *sb, const void *data, size_t len);
void  lume_sb_printf(lume_sb_t *sb, const char *fmt, ...);
/* Writes `s` as a JSON string literal (with surrounding quotes, escaped). */
void  lume_json_escape(lume_sb_t *sb, const char *s);
/* Hands ownership of the buffer to the caller (buffer must be freed). */
char *lume_sb_detach(lume_sb_t *sb);

/* ------------------------------------------------------------------ */
/* Minimal JSON object builder                                         */
/* ------------------------------------------------------------------ */
void lume_json_open(lume_sb_t *sb);
void lume_json_close(lume_sb_t *sb);
void lume_json_kv_str(lume_sb_t *sb, const char *key, const char *val, int *first);
void lume_json_kv_int(lume_sb_t *sb, const char *key, long val, int *first);
void lume_json_kv_ll(lume_sb_t *sb, const char *key, long long val, int *first);
void lume_json_kv_double(lume_sb_t *sb, const char *key, double val, int *first);
void lume_json_kv_bool(lume_sb_t *sb, const char *key, int val, int *first);
void lume_json_kv_raw(lume_sb_t *sb, const char *key, const char *raw, int *first);

/* ------------------------------------------------------------------ */
/* MIME types                                                          */
/* ------------------------------------------------------------------ */
const char *lume_mime_type(const char *path);

/* ------------------------------------------------------------------ */
/* Portable file helpers                                               */
/* ------------------------------------------------------------------ */
int lume_file_read(const char *path, char **out, size_t *out_len);
int lume_file_write(const char *path, const void *data, size_t len);
int lume_mkdir_p(const char *path);
int lume_path_exists(const char *path);
int lume_is_dir(const char *path);
/* Joins two path segments with a single '/'; result is heap-allocated. */
char *lume_path_join(const char *a, const char *b);
/* Basename (pointer into `path`, no allocation). */
const char *lume_basename(const char *path);

/* ------------------------------------------------------------------ */
/* Time                                                                */
/* ------------------------------------------------------------------ */
/* Writes an ISO-8601 UTC timestamp (e.g. 2026-10-24T13:59:35Z). */
void lume_iso8601_now(char out[21]);

#ifdef __cplusplus
}
#endif
#endif /* LUME_CORE_H */
