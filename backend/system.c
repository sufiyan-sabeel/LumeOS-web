/*
 * LumeOS - backend/system.c
 * OS telemetry, package repository listing, gated native execution and the
 * self-contained source export endpoint.
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
#include <sys/statvfs.h>
#include <sys/utsname.h>
#include <unistd.h>

/* ------------------------------------------------------------------ */
/* GET /api/system/info                                                */
/* ------------------------------------------------------------------ */
void handle_system_info(const server_config_t *cfg, const http_request_t *req,
                        http_response_t *res) {
    (void)cfg; (void)req;

    struct utsname u;
    memset(&u, 0, sizeof(u));
    uname(&u);

    /* Memory: parse /proc/meminfo. */
    unsigned long long mem_total_kb = 0, mem_avail_kb = 0;
    FILE *f = fopen("/proc/meminfo", "r");
    if (f) {
        char line[256];
        while (fgets(line, sizeof(line), f)) {
            if (strncmp(line, "MemTotal:", 9) == 0)
                sscanf(line + 9, "%llu", &mem_total_kb);
            else if (strncmp(line, "MemAvailable:", 13) == 0)
                sscanf(line + 13, "%llu", &mem_avail_kb);
        }
        fclose(f);
    }

    /* Load average. */
    double load1 = 0.0, load5 = 0.0, load15 = 0.0;
    if (getloadavg(&load1, 3) < 0) { load1 = load5 = load15 = 0.0; }
    (void)getloadavg(&load5, 1);
    (void)getloadavg(&load15, 1);
    {
        double tmp[3] = {0, 0, 0};
        if (getloadavg(tmp, 3) == 3) { load1 = tmp[0]; load5 = tmp[1]; load15 = tmp[2]; }
    }

    /* Disk (data dir). */
    unsigned long long disk_total = 0, disk_free = 0;
    struct statvfs vfs;
    if (statvfs(cfg ? cfg->datadir : ".", &vfs) == 0) {
        disk_total = (unsigned long long)vfs.f_blocks * vfs.f_frsize;
        disk_free  = (unsigned long long)vfs.f_bavail * vfs.f_frsize;
    }

    long cpus = sysconf(_SC_NPROCESSORS_ONLN);

    lume_sb_t sb;
    lume_sb_init(&sb);
    lume_sb_putc(&sb, '{');
    int first = 1;
    lume_json_kv_str(&sb, "os", u.sysname, &first);
    lume_json_kv_str(&sb, "kernel", u.release, &first);
    lume_json_kv_str(&sb, "arch", u.machine, &first);
    lume_json_kv_str(&sb, "hostname", u.nodename, &first);
    lume_json_kv_ll(&sb, "cpus", cpus, &first);
    lume_json_kv_ll(&sb, "mem_total_kb", (long long)mem_total_kb, &first);
    lume_json_kv_ll(&sb, "mem_available_kb", (long long)mem_avail_kb, &first);
    lume_json_kv_double(&sb, "load1", load1, &first);
    lume_json_kv_double(&sb, "load5", load5, &first);
    lume_json_kv_double(&sb, "load15", load15, &first);
    lume_json_kv_ll(&sb, "disk_total_bytes", (long long)disk_total, &first);
    lume_json_kv_ll(&sb, "disk_free_bytes", (long long)disk_free, &first);
    lume_json_kv_str(&sb, "lume_version", LUME_VERSION, &first);
    char ts[21];
    lume_iso8601_now(ts);
    lume_json_kv_str(&sb, "time", ts, &first);
    lume_sb_putc(&sb, '}');

    resp_json(res, 200, sb.buf);
    lume_sb_free(&sb);
}

/* ------------------------------------------------------------------ */
/* GET /api/packages                                                   */
/* ------------------------------------------------------------------ */
static void append_package(lume_sb_t *sb, int *first, const char *name,
                           const char *relpath, long size, int is_dir) {
    if (!*first) lume_sb_putc(sb, ',');
    *first = 0;
    lume_sb_putc(sb, '{');
    int f = 1;
    lume_json_kv_str(sb, "name", name, &f);
    lume_json_kv_str(sb, "path", relpath, &f);
    lume_json_kv_ll(sb, "size", size, &f);
    lume_json_kv_str(sb, "kind", is_dir ? "bundle" : "archive", &f);
    lume_sb_putc(sb, '}');
}

void handle_packages_list(const server_config_t *cfg, const http_request_t *req,
                          http_response_t *res) {
    (void)req;

    lume_sb_t sb;
    lume_sb_init(&sb);
    lume_sb_puts(&sb, "{\"packages\":[");
    int first = 1;

    DIR *d = cfg ? opendir(cfg->pkgdir) : NULL;
    if (d) {
        struct dirent *ent;
        while ((ent = readdir(d)) != NULL) {
            if (ent->d_name[0] == '.') continue;
            char full[LUME_MAX_PATH];
            if (snprintf(full, sizeof(full), "%s/%s", cfg->pkgdir, ent->d_name) >=
                (int)sizeof(full))
                continue;
            struct stat st;
            if (stat(full, &st) != 0) continue;

            if (S_ISDIR(st.st_mode)) {
                /* A bundle must contain a manifest.lume.json. */
                char mf[LUME_MAX_PATH];
                snprintf(mf, sizeof(mf), "%s/manifest.lume.json", full);
                if (!lume_path_exists(mf)) continue;
                append_package(&sb, &first, ent->d_name, ent->d_name, 0, 1);
            } else if (lume_ends_with(ent->d_name, ".lume")) {
                append_package(&sb, &first, ent->d_name, ent->d_name,
                               (long)st.st_size, 0);
            }
        }
        closedir(d);
    }

    lume_sb_puts(&sb, "]}");
    resp_json(res, 200, sb.buf);
    lume_sb_free(&sb);
}

/* ------------------------------------------------------------------ */
/* POST /api/system/exec-native   {"binary":"lume-hello"}              */
/* Gated by: valid token AND presence in data/database/native_registry */
/* ------------------------------------------------------------------ */
static int binary_is_registered(const server_config_t *cfg, const char *name) {
    char reg[LUME_MAX_PATH];
    if (snprintf(reg, sizeof(reg), "%s/database/native_registry.txt",
                 cfg->datadir) >= (int)sizeof(reg))
        return 0;
    FILE *f = fopen(reg, "r");
    if (!f) return 0;
    char line[512];
    int found = 0;
    while (fgets(line, sizeof(line), f)) {
        lume_trim(line);
        if (line[0] == '\0' || line[0] == '#') continue;
        if (strcmp(line, name) == 0) { found = 1; break; }
    }
    fclose(f);
    return found;
}

void handle_exec_native(const server_config_t *cfg, const http_request_t *req,
                        http_response_t *res) {
    if (!lume_token_authorized(cfg, req)) {
        resp_error(res, 401, "unauthorized");
        return;
    }
    char name[256];
    if (json_get_string(req->body, "binary", name, sizeof(name)) != 0) {
        resp_error(res, 400, "missing 'binary'");
        return;
    }
    /* Only allow simple basenames: no slashes, no shell metacharacters. */
    for (const char *p = name; *p; ++p) {
        if (!((*p >= 'a' && *p <= 'z') || (*p >= 'A' && *p <= 'Z') ||
              (*p >= '0' && *p <= '9') || *p == '-' || *p == '_' || *p == '.')) {
            resp_error(res, 400, "invalid binary name");
            return;
        }
    }
    if (!binary_is_registered(cfg, name)) {
        resp_error(res, 403, "binary not in native registry (denied)");
        return;
    }

    char path[LUME_MAX_PATH];
    snprintf(path, sizeof(path), "%s/database/native/%s", cfg->datadir, name);
    if (!lume_path_exists(path)) {
        resp_error(res, 404, "registered binary not installed");
        return;
    }

    /* Execute with a strict timeout via `timeout`, capturing stdout. */
    char cmd[LUME_MAX_PATH + 64];
    snprintf(cmd, sizeof(cmd), "timeout 10 '%s' 2>&1", path);
    FILE *p = popen(cmd, "r");
    if (!p) { resp_error(res, 500, "exec failed"); return; }

    lume_sb_t out;
    lume_sb_init(&out);
    char buf[512];
    size_t total = 0;
    while (fgets(buf, sizeof(buf), p) && total < 65536) {
        lume_sb_puts(&out, buf);
        total += strlen(buf);
    }
    int rc = pclose(p);

    lume_sb_t sb;
    lume_sb_init(&sb);
    lume_sb_putc(&sb, '{');
    int f = 1;
    lume_json_kv_str(&sb, "binary", name, &f);
    lume_json_kv_int(&sb, "exit_code", rc, &f);
    lume_json_kv_str(&sb, "stdout", out.buf ? out.buf : "", &f);
    lume_sb_putc(&sb, '}');

    lume_sb_free(&out);
    resp_json(res, 200, sb.buf);
    lume_sb_free(&sb);
}

/* ------------------------------------------------------------------ */
/* GET /api/export/project  -> downloadable tar.gz of the source tree  */
/* ------------------------------------------------------------------ */
void handle_export_project(const server_config_t *cfg, const http_request_t *req,
                           http_response_t *res) {
    (void)req;
    if (!cfg || !cfg->srcdir || !lume_is_dir(cfg->srcdir)) {
        resp_error(res, 500, "source directory unavailable");
        return;
    }

    char exports[LUME_MAX_PATH];
    snprintf(exports, sizeof(exports), "%s/exports", cfg->datadir);
    lume_mkdir_p(exports);

    char out[LUME_MAX_PATH];
    snprintf(out, sizeof(out), "%s/lumeos-source.tar.gz", exports);

    /* Split srcdir into parent + basename for a portable tar -C invocation. */
    char srcdir[LUME_MAX_PATH];
    snprintf(srcdir, sizeof(srcdir), "%s", cfg->srcdir);
    size_t len = strlen(srcdir);
    while (len > 1 && srcdir[len - 1] == '/') srcdir[--len] = '\0';
    char *slash = strrchr(srcdir, '/');
    const char *base = srcdir;
    char parent[LUME_MAX_PATH];
    if (slash && slash != srcdir) {
        *slash = '\0';
        base = slash + 1;
        snprintf(parent, sizeof(parent), "%s", srcdir);
    } else {
        snprintf(parent, sizeof(parent), ".");
    }

    char cmd[LUME_MAX_PATH * 2 + 128];
    snprintf(cmd, sizeof(cmd),
             "tar czf '%s' --exclude='./build' --exclude='*/build' "
             "--exclude='*/exports' -C '%s' '%s' 2>&1",
             out, parent, base);
    FILE *p = popen(cmd, "r");
    if (!p) { resp_error(res, 500, "archive failed"); return; }
    char err[512] = "";
    size_t n = fread(err, 1, sizeof(err) - 1, p);
    err[n] = '\0';
    int rc = pclose(p);

    struct stat st;
    if (rc != 0 || stat(out, &st) != 0) {
        resp_error(res, 500, err[0] ? err : "archive failed");
        return;
    }

    snprintf(res->extra_headers, sizeof(res->extra_headers),
             "Content-Disposition: attachment; filename=\"lumeos-source.tar.gz\"\r\n");
    resp_file(res, out, "application/gzip", (long)st.st_size);
}

/* ------------------------------------------------------------------ */
/* GET /api/health                                                     */
/* ------------------------------------------------------------------ */
void handle_health(const server_config_t *cfg, const http_request_t *req,
                   http_response_t *res) {
    (void)cfg; (void)req;
    char ts[21];
    lume_iso8601_now(ts);
    lume_sb_t sb;
    lume_sb_init(&sb);
    lume_sb_putc(&sb, '{');
    int f = 1;
    lume_json_kv_str(&sb, "status", "ok", &f);
    lume_json_kv_str(&sb, "service", "LumeOS", &f);
    lume_json_kv_str(&sb, "version", LUME_VERSION, &f);
    lume_json_kv_str(&sb, "time", ts, &f);
    lume_sb_putc(&sb, '}');
    resp_json(res, 200, sb.buf);
    lume_sb_free(&sb);
}
