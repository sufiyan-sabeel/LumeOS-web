/*
 * LumeOS - backend/files.c
 * POSIX file operations bridging the server-side virtual disk (data/files/).
 * All paths are canonicalized through lume_secure_path() so that no request
 * can escape the data directory.
 */
#define _POSIX_C_SOURCE 200809L
#define _DEFAULT_SOURCE

#include "routes.h"
#include "security.h"
#include "core.h"

#include <dirent.h>
#include <errno.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <unistd.h>

/* Resolve a request-relative path against the data/files root.
 * Returns 0 on success, -1 on failure (and fills `res` with an error). */
static int resolve_data_path(const server_config_t *cfg, const char *rel,
                             char *out, size_t outsz, http_response_t *res) {
    char filesroot[LUME_MAX_PATH];
    if (snprintf(filesroot, sizeof(filesroot), "%s/files", cfg->datadir) >=
        (int)sizeof(filesroot)) {
        resp_error(res, 500, "data root path too long");
        return -1;
    }
    lume_mkdir_p(filesroot);

    if (lume_secure_path(filesroot, rel && *rel ? rel : "/", out, outsz) != 0) {
        resp_error(res, 403, "path outside of data/files (rejected)");
        return -1;
    }
    return 0;
}

/* ------------------------------------------------------------------ */
/* GET /api/files/list?path=/                                          */
/* ------------------------------------------------------------------ */
void handle_files_list(const server_config_t *cfg, const http_request_t *req,
                       http_response_t *res) {
    char rel[LUME_MAX_PATH] = "/";
    query_get(req->query, "path", rel, sizeof(rel));

    char path[LUME_MAX_PATH];
    if (resolve_data_path(cfg, rel, path, sizeof(path), res) != 0) return;

    if (!lume_path_exists(path)) { resp_error(res, 404, "not found"); return; }
    if (!lume_is_dir(path))      { resp_error(res, 400, "not a directory"); return; }

    DIR *d = opendir(path);
    if (!d) { resp_error(res, 500, "cannot open directory"); return; }

    lume_sb_t sb;
    lume_sb_init(&sb);
    lume_sb_puts(&sb, "{\"path\":");
    lume_json_escape(&sb, rel);
    lume_sb_puts(&sb, ",\"entries\":[");

    struct dirent *ent;
    int first = 1;
    while ((ent = readdir(d)) != NULL) {
        if (strcmp(ent->d_name, ".") == 0 || strcmp(ent->d_name, "..") == 0)
            continue;

        char full[LUME_MAX_PATH];
        if (snprintf(full, sizeof(full), "%s/%s", path, ent->d_name) >=
            (int)sizeof(full))
            continue;

        struct stat st;
        if (stat(full, &st) != 0) continue;

        if (!first) lume_sb_putc(&sb, ',');
        first = 0;

        lume_sb_putc(&sb, '{');
        int f = 1;
        lume_json_kv_str(&sb, "name", ent->d_name, &f);
        lume_json_kv_str(&sb, "type", S_ISDIR(st.st_mode) ? "dir" : "file", &f);
        lume_json_kv_ll(&sb, "size", (long long)st.st_size, &f);
        lume_json_kv_ll(&sb, "mtime", (long long)st.st_mtime, &f);
        lume_sb_putc(&sb, '}');
    }
    closedir(d);

    lume_sb_puts(&sb, "]}");
    resp_json(res, 200, sb.buf);
    lume_sb_free(&sb);
}

/* ------------------------------------------------------------------ */
/* GET /api/files/read?path=/notes.txt                                 */
/* ------------------------------------------------------------------ */
void handle_files_read(const server_config_t *cfg, const http_request_t *req,
                       http_response_t *res) {
    char rel[LUME_MAX_PATH] = "";
    if (query_get(req->query, "path", rel, sizeof(rel)) != 0) {
        resp_error(res, 400, "missing ?path");
        return;
    }

    char path[LUME_MAX_PATH];
    if (resolve_data_path(cfg, rel, path, sizeof(path), res) != 0) return;
    if (!lume_path_exists(path) || lume_is_dir(path)) {
        resp_error(res, 404, "file not found");
        return;
    }

    char *data = NULL;
    size_t len = 0;
    if (lume_file_read(path, &data, &len) != 0) {
        resp_error(res, 500, "read failed");
        return;
    }

    lume_sb_t sb;
    lume_sb_init(&sb);
    lume_sb_putc(&sb, '{');
    int f = 1;
    lume_json_kv_str(&sb, "path", rel, &f);
    lume_json_kv_ll(&sb, "size", (long long)len, &f);
    lume_json_kv_str(&sb, "content", data, &f);
    char sha[65];
    lume_sha256_hex(data, len, sha);
    lume_json_kv_str(&sb, "sha256", sha, &f);
    lume_sb_putc(&sb, '}');

    free(data);
    resp_json(res, 200, sb.buf);
    lume_sb_free(&sb);
}

/* ------------------------------------------------------------------ */
/* POST /api/files/write   {"path":"/a.txt","content":"..."}           */
/* ------------------------------------------------------------------ */
void handle_files_write(const server_config_t *cfg, const http_request_t *req,
                        http_response_t *res) {
    if (!lume_token_authorized(cfg, req)) {
        resp_error(res, 401, "unauthorized: missing or invalid X-Lume-Token");
        return;
    }

    char rel[LUME_MAX_PATH];
    if (json_get_string(req->body, "path", rel, sizeof(rel)) != 0) {
        resp_error(res, 400, "missing 'path' in JSON body");
        return;
    }

    /* 'content' may legitimately be empty, so detect its presence. */
    const char *content = NULL;
    char *content_buf = NULL;
    if (req->body && strstr(req->body, "\"content\"")) {
        content_buf = malloc(req->body_len + 1);
        if (content_buf && json_get_string(req->body, "content", content_buf,
                                           req->body_len + 1) == 0)
            content = content_buf;
    }
    if (!content) { free(content_buf); resp_error(res, 400, "missing 'content'"); return; }

    char path[LUME_MAX_PATH];
    if (resolve_data_path(cfg, rel, path, sizeof(path), res) != 0) {
        free(content_buf);
        return;
    }

    /* Ensure parent directory exists. */
    char parent[LUME_MAX_PATH];
    snprintf(parent, sizeof(parent), "%s", path);
    char *slash = strrchr(parent, '/');
    if (slash && slash != parent) { *slash = '\0'; lume_mkdir_p(parent); }

    if (lume_file_write(path, content, strlen(content)) != 0) {
        free(content_buf);
        resp_error(res, 500, "write failed");
        return;
    }
    free(content_buf);

    lume_sb_t sb;
    lume_sb_init(&sb);
    lume_sb_putc(&sb, '{');
    int f = 1;
    lume_json_kv_str(&sb, "ok", "written", &f);
    lume_json_kv_str(&sb, "path", rel, &f);
    lume_json_kv_ll(&sb, "bytes", (long long)strlen(content ? content : ""), &f);
    lume_sb_putc(&sb, '}');
    resp_json(res, 200, sb.buf);
    lume_sb_free(&sb);
}

/* ------------------------------------------------------------------ */
/* POST /api/files/mkdir   {"path":"/newdir"}                          */
/* ------------------------------------------------------------------ */
void handle_files_mkdir(const server_config_t *cfg, const http_request_t *req,
                        http_response_t *res) {
    if (!lume_token_authorized(cfg, req)) {
        resp_error(res, 401, "unauthorized");
        return;
    }
    char rel[LUME_MAX_PATH];
    if (json_get_string(req->body, "path", rel, sizeof(rel)) != 0) {
        resp_error(res, 400, "missing 'path'");
        return;
    }
    char path[LUME_MAX_PATH];
    if (resolve_data_path(cfg, rel, path, sizeof(path), res) != 0) return;

    if (lume_mkdir_p(path) != 0) { resp_error(res, 500, "mkdir failed"); return; }
    resp_json(res, 200, "{\"ok\":\"created\"}");
}

/* ------------------------------------------------------------------ */
/* DELETE /api/files/delete?path=/a.txt                                */
/* ------------------------------------------------------------------ */
void handle_files_delete(const server_config_t *cfg, const http_request_t *req,
                         http_response_t *res) {
    if (!lume_token_authorized(cfg, req)) {
        resp_error(res, 401, "unauthorized");
        return;
    }
    char rel[LUME_MAX_PATH];
    if (query_get(req->query, "path", rel, sizeof(rel)) != 0) {
        resp_error(res, 400, "missing ?path");
        return;
    }

    char path[LUME_MAX_PATH];
    if (resolve_data_path(cfg, rel, path, sizeof(path), res) != 0) return;

    /* Refuse to delete the data root itself. */
    char filesroot[LUME_MAX_PATH];
    snprintf(filesroot, sizeof(filesroot), "%s/files", cfg->datadir);
    char root_real[LUME_MAX_PATH];
    if (realpath(filesroot, root_real) && strcmp(path, root_real) == 0) {
        resp_error(res, 403, "refusing to delete data root");
        return;
    }

    if (!lume_path_exists(path)) { resp_error(res, 404, "not found"); return; }

    int rc = lume_is_dir(path) ? rmdir(path) : unlink(path);
    if (rc != 0) {
        resp_error(res, 409, lume_is_dir(path) ? "directory not empty"
                                               : "delete failed");
        return;
    }
    resp_json(res, 200, "{\"ok\":\"deleted\"}");
}
