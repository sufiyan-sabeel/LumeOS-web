/*
 * LumeOS - backend/routes.c
 * REST router, response helpers and static file serving for frontend/.
 */
#define _POSIX_C_SOURCE 200809L

#include "routes.h"
#include "security.h"
#include "core.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>

/* ================================================================== */
/* Response helpers                                                    */
/* ================================================================== */
void resp_init(http_response_t *res) {
    memset(res, 0, sizeof(*res));
    res->status = 200;
    snprintf(res->content_type, sizeof(res->content_type), "text/plain; charset=utf-8");
    res->is_file = 0;
    res->file_offset = 0;
    res->file_length = -1;
}

void resp_free(http_response_t *res) {
    if (res && res->body) {
        free(res->body);
        res->body = NULL;
    }
}

void resp_text(http_response_t *res, int status, const char *body) {
    resp_free(res);
    res->status = status;
    snprintf(res->content_type, sizeof(res->content_type), "text/plain; charset=utf-8");
    res->body = lume_strdup(body ? body : "");
    res->body_len = res->body ? strlen(res->body) : 0;
    res->is_file = 0;
}

void resp_json(http_response_t *res, int status, const char *json) {
    resp_free(res);
    res->status = status;
    snprintf(res->content_type, sizeof(res->content_type),
             "application/json; charset=utf-8");
    res->body = lume_strdup(json ? json : "{}");
    res->body_len = res->body ? strlen(res->body) : 0;
    res->is_file = 0;
}

void resp_error(http_response_t *res, int status, const char *message) {
    lume_sb_t sb;
    lume_sb_init(&sb);
    lume_sb_putc(&sb, '{');
    int f = 1;
    lume_json_kv_bool(&sb, "error", 1, &f);
    lume_json_kv_int(&sb, "status", status, &f);
    lume_json_kv_str(&sb, "message", message ? message : "error", &f);
    lume_sb_putc(&sb, '}');
    resp_json(res, status, sb.buf);
    lume_sb_free(&sb);
}

void resp_file(http_response_t *res, const char *path, const char *mime, long len) {
    resp_free(res);
    res->status = 200;
    snprintf(res->content_type, sizeof(res->content_type), "%s",
             mime ? mime : "application/octet-stream");
    snprintf(res->file_path, sizeof(res->file_path), "%s", path);
    res->file_offset = 0;
    res->file_length = len;
    res->is_file = 1;
    res->body = NULL;
    res->body_len = (len >= 0) ? (size_t)len : 0;
}

/* ================================================================== */
/* Tiny query / JSON helpers                                           */
/* ================================================================== */
int query_get(const char *query, const char *key, char *out, size_t outsz) {
    if (!query || !key || !out || outsz == 0) return -1;
    size_t klen = strlen(key);
    const char *p = query;
    while (*p) {
        /* match "key=" */
        if (strncmp(p, key, klen) == 0 && p[klen] == '=') {
            const char *val = p + klen + 1;
            const char *end = strchr(val, '&');
            size_t vlen = end ? (size_t)(end - val) : strlen(val);
            char raw[LUME_MAX_PATH];
            if (vlen >= sizeof(raw)) vlen = sizeof(raw) - 1;
            memcpy(raw, val, vlen);
            raw[vlen] = '\0';
            if (lume_url_decode(raw, out, outsz) != 0) {
                snprintf(out, outsz, "%s", raw);
            }
            return 0;
        }
        const char *amp = strchr(p, '&');
        if (!amp) break;
        p = amp + 1;
    }
    return -1;
}

int json_get_string(const char *json, const char *key, char *out, size_t outsz) {
    if (!json || !key || !out || outsz == 0) return -1;

    /* Locate "key" */
    char needle[256];
    snprintf(needle, sizeof(needle), "\"%s\"", key);
    const char *p = strstr(json, needle);
    if (!p) return -1;
    p += strlen(needle);
    while (*p == ' ' || *p == '\t' || *p == '\n' || *p == '\r') p++;
    if (*p != ':') return -1;
    p++;
    while (*p == ' ' || *p == '\t' || *p == '\n' || *p == '\r') p++;
    if (*p != '"') return -1;
    p++;

    size_t o = 0;
    while (*p && *p != '"') {
        char c = *p;
        if (c == '\\' && p[1]) {
            p++;
            switch (*p) {
                case 'n': c = '\n'; break;
                case 't': c = '\t'; break;
                case 'r': c = '\r'; break;
                case 'b': c = '\b'; break;
                case 'f': c = '\f'; break;
                case '"': c = '"';  break;
                case '\\': c = '\\'; break;
                case '/': c = '/';  break;
                default:  c = *p;   break;
            }
        }
        if (o + 1 >= outsz) return -1;
        out[o++] = c;
        p++;
    }
    if (*p != '"') return -1;
    out[o] = '\0';
    return 0;
}

/* ================================================================== */
/* Static file serving                                                 */
/* ================================================================== */
static void serve_index(const server_config_t *cfg, http_response_t *res) {
    char idx[LUME_MAX_PATH];
    snprintf(idx, sizeof(idx), "%s/index.html", cfg->webroot);
    if (!lume_path_exists(idx)) {
        resp_error(res, 404, "index.html not found (run `make build-frontend`)");
        return;
    }
    struct stat st;
    stat(idx, &st);
    resp_file(res, idx, "text/html; charset=utf-8", (long)st.st_size);
}

void handle_static(const server_config_t *cfg, const http_request_t *req,
                   http_response_t *res) {
    const char *path = req->path;

    if (strcmp(path, "/") == 0 || strcmp(path, "/index.html") == 0) {
        serve_index(cfg, res);
        return;
    }

    char resolved[LUME_MAX_PATH];
    if (lume_secure_path(cfg->webroot, path, resolved, sizeof(resolved)) != 0) {
        resp_error(res, 403, "forbidden");
        return;
    }

    struct stat st;
    if (stat(resolved, &st) != 0) {
        resp_error(res, 404, "not found");
        return;
    }

    if (S_ISDIR(st.st_mode)) {
        char idx[LUME_MAX_PATH];
        snprintf(idx, sizeof(idx), "%s/index.html", resolved);
        if (lume_path_exists(idx)) {
            stat(idx, &st);
            resp_file(res, idx, "text/html; charset=utf-8", (long)st.st_size);
            return;
        }
        resp_error(res, 404, "directory listing disabled");
        return;
    }

    resp_file(res, resolved, lume_mime_type(resolved), (long)st.st_size);
}

/* ================================================================== */
/* Router                                                              */
/* ================================================================== */
void lume_route(const server_config_t *cfg, const http_request_t *req,
                http_response_t *res) {
    const char *m = req->method;
    const char *p = req->path;

    /* Pre-flight */
    if (strcmp(m, "OPTIONS") == 0) {
        res->status = 204;
        return;
    }

    if (strcmp(p, "/api/health") == 0)               { handle_health(cfg, req, res); return; }
    if (strcmp(p, "/api/system/info") == 0)          { handle_system_info(cfg, req, res); return; }
    if (strcmp(p, "/api/packages") == 0)             { handle_packages_list(cfg, req, res); return; }
    if (strcmp(p, "/api/system/exec-native") == 0)   { handle_exec_native(cfg, req, res); return; }
    if (strcmp(p, "/api/export/project") == 0)       { handle_export_project(cfg, req, res); return; }

    if (strcmp(p, "/api/files/list") == 0)           { handle_files_list(cfg, req, res); return; }
    if (strcmp(p, "/api/files/read") == 0)           { handle_files_read(cfg, req, res); return; }
    if (strcmp(p, "/api/files/write") == 0)          { handle_files_write(cfg, req, res); return; }
    if (strcmp(p, "/api/files/mkdir") == 0)          { handle_files_mkdir(cfg, req, res); return; }
    if (strcmp(p, "/api/files/delete") == 0)         { handle_files_delete(cfg, req, res); return; }

    /* Package repository files: /packages/<id>/<file> */
    if (lume_starts_with(p, "/packages/")) {
        char resolved[LUME_MAX_PATH];
        if (lume_secure_path(cfg->pkgdir, p + strlen("/packages"),
                             resolved, sizeof(resolved)) != 0) {
            resp_error(res, 403, "forbidden");
            return;
        }
        struct stat pst;
        if (stat(resolved, &pst) != 0 || S_ISDIR(pst.st_mode)) {
            resp_error(res, 404, "package file not found");
            return;
        }
        resp_file(res, resolved, lume_mime_type(resolved), (long)pst.st_size);
        return;
    }

    /* Unknown API route */
    if (lume_starts_with(p, "/api/")) {
        resp_error(res, 404, "unknown API route");
        return;
    }

    /* Everything else: static assets. */
    if (strcmp(m, "GET") == 0 || strcmp(m, "HEAD") == 0) {
        handle_static(cfg, req, res);
        return;
    }

    resp_error(res, 405, "method not allowed");
}
