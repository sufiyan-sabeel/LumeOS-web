/*
 * LumeOS - backend/security.c
 * Path canonicalization (anti traversal), token auth, CORS + hardening.
 */
#define _POSIX_C_SOURCE 200809L
#define _DEFAULT_SOURCE

#include "security.h"
#include "core.h"

#include <ctype.h>
#include <fcntl.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>
#include <unistd.h>

/* ------------------------------------------------------------------ */
/* URL percent-decoding                                                */
/* ------------------------------------------------------------------ */
static int hexval(int c) {
    if (c >= '0' && c <= '9') return c - '0';
    if (c >= 'a' && c <= 'f') return c - 'a' + 10;
    if (c >= 'A' && c <= 'F') return c - 'A' + 10;
    return -1;
}

int lume_url_decode(const char *in, char *out, size_t outsz) {
    if (!in || !out || outsz == 0) return -1;
    size_t o = 0;
    for (size_t i = 0; in[i]; ++i) {
        if (o + 1 >= outsz) return -1;
        if (in[i] == '%') {
            int hi = hexval((unsigned char)in[i + 1]);
            int lo = hi < 0 ? -1 : hexval((unsigned char)in[i + 2]);
            if (hi < 0 || lo < 0) return -1;
            out[o++] = (char)((hi << 4) | lo);
            i += 2;
        } else if (in[i] == '+') {
            out[o++] = ' ';
        } else {
            out[o++] = in[i];
        }
    }
    out[o] = '\0';
    return 0;
}

/* ------------------------------------------------------------------ */
/* Path containment                                                    */
/* ------------------------------------------------------------------ */
static int is_within(const char *root, const char *path) {
    size_t rl = strlen(root);
    if (strncmp(path, root, rl) != 0) return 0;
    if (path[rl] == '\0' || path[rl] == '/') return 1;
    return 0;
}

int lume_secure_path(const char *root, const char *requested,
                     char *out, size_t outsz) {
    if (!root || !requested || !out || outsz == 0) return -1;

    /* Reject embedded NUL (already terminated) and control chars. */
    for (const char *p = requested; *p; ++p)
        if ((unsigned char)*p < 0x20) return -1;

    /* Canonicalize the root once. */
    char root_real[LUME_MAX_PATH];
    if (!realpath(root, root_real)) return -1;

    /* Strip leading slashes so join stays inside root. */
    const char *rel = requested;
    while (*rel == '/') rel++;

    char candidate[LUME_MAX_PATH];
    if (snprintf(candidate, sizeof(candidate), "%s/%s", root_real, rel) >=
        (int)sizeof(candidate))
        return -1;

    /* Fast reject obvious traversal before touching the FS. */
    if (strstr(rel, "..") != NULL) {
        /* Allow only if realpath proves it stays inside; fall through. */
    }

    char resolved[LUME_MAX_PATH];
    if (realpath(candidate, resolved)) {
        if (!is_within(root_real, resolved)) return -1;
        if (snprintf(out, outsz, "%s", resolved) >= (int)outsz) return -1;
        return 0;
    }

    /* Target may not exist yet (writes/mkdir). Walk up to the deepest
     * existing ancestor, verify it is inside root, then re-attach the
     * remaining suffix after validating every component. This supports
     * creating files several levels deep (e.g. /a/b/c.txt) while still
     * rejecting any traversal. */
    char probe[LUME_MAX_PATH];
    if (snprintf(probe, sizeof(probe), "%s", candidate) >= (int)sizeof(probe))
        return -1;
    char suffix[LUME_MAX_PATH];
    suffix[0] = '\0';

    for (;;) {
        char ancestor[LUME_MAX_PATH];
        if (realpath(probe, ancestor)) {
            if (!is_within(root_real, ancestor)) return -1;
            int rc = suffix[0] ? snprintf(out, outsz, "%s/%s", ancestor, suffix)
                               : snprintf(out, outsz, "%s", ancestor);
            if (rc >= (int)outsz) return -1;
            return 0;
        }
        char *sl = strrchr(probe, '/');
        if (!sl || sl == probe) return -1;
        *sl = '\0';
        const char *comp = sl + 1;
        if (comp[0] == '\0' || strcmp(comp, ".") == 0 || strcmp(comp, "..") == 0)
            return -1;
        char new_suffix[LUME_MAX_PATH];
        if (suffix[0])
            snprintf(new_suffix, sizeof(new_suffix), "%s/%s", comp, suffix);
        else
            snprintf(new_suffix, sizeof(new_suffix), "%s", comp);
        snprintf(suffix, sizeof(suffix), "%s", new_suffix);
    }
}

/* ------------------------------------------------------------------ */
/* Token authentication                                                */
/* ------------------------------------------------------------------ */
int lume_token_authorized(const server_config_t *cfg, const http_request_t *req) {
    if (!cfg || !req) return 0;
    if (cfg->token[0] == '\0') return 1; /* auth disabled (e.g. tests) */

    const char *cand = req->token;
    /* Accept "Bearer <tok>" in Authorization as well. */
    if (cand[0] == '\0' && lume_starts_with(req->auth, "Bearer ")) {
        cand = req->auth + 7;
    }
    if (cand[0] == '\0') return 0;

    size_t cl = strlen(cand), tl = strlen(cfg->token);
    if (cl != tl) return 0;
    return lume_ct_equal(cand, cfg->token, tl);
}

/* ------------------------------------------------------------------ */
/* Security / CORS headers                                             */
/* ------------------------------------------------------------------ */
void lume_apply_security_headers(const server_config_t *cfg,
                                 const http_request_t *req,
                                 http_response_t *res) {
    (void)cfg;
    const char *origin = (req && req->origin[0]) ? req->origin : "*";
    snprintf(res->extra_headers, sizeof(res->extra_headers),
             "Access-Control-Allow-Origin: %s\r\n"
             "Access-Control-Allow-Methods: GET, POST, PUT, DELETE, OPTIONS\r\n"
             "Access-Control-Allow-Headers: Content-Type, X-Lume-Token, Authorization\r\n"
             "Access-Control-Max-Age: 600\r\n"
             "X-Content-Type-Options: nosniff\r\n"
             "X-Frame-Options: SAMEORIGIN\r\n"
             "Referrer-Policy: no-referrer\r\n"
             "Cache-Control: no-store\r\n",
             origin);
}

/* ------------------------------------------------------------------ */
/* Token generation                                                    */
/* ------------------------------------------------------------------ */
void lume_generate_token(size_t bytes, char *out, size_t outsz) {
    if (!out || outsz == 0) return;
    if (bytes * 2 + 1 > outsz) bytes = (outsz - 1) / 2;

    unsigned char buf[64];
    if (bytes > sizeof(buf)) bytes = sizeof(buf);

    int got = 0;
    int fd = open("/dev/urandom", O_RDONLY);
    if (fd >= 0) {
        ssize_t n = read(fd, buf, bytes);
        if (n > 0) got = (int)n;
        close(fd);
    }
    if (got < (int)bytes) {
        /* Fallback: time + pid mixed entropy. */
        unsigned long seed = (unsigned long)time(NULL) ^ ((unsigned long)getpid() << 16);
        for (size_t i = (size_t)got; i < bytes; ++i) {
            seed = seed * 6364136223846793005UL + 1442695040888963407UL;
            buf[i] = (unsigned char)(seed >> 33);
        }
    }

    static const char hex[] = "0123456789abcdef";
    for (size_t i = 0; i < bytes; ++i) {
        out[i * 2]     = hex[(buf[i] >> 4) & 0xf];
        out[i * 2 + 1] = hex[buf[i] & 0xf];
    }
    out[bytes * 2] = '\0';
}
