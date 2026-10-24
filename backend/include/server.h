/*
 * LumeOS - backend/include/server.h
 * HTTP/1.1 server types, configuration and lifecycle.
 */
#ifndef LUME_SERVER_H
#define LUME_SERVER_H

#include <stddef.h>
#include <stdint.h>

#define LUME_MAX_HEADERS    64
#define LUME_MAX_HEADER_LEN 8192
#define LUME_MAX_PATH       2048
#define LUME_MAX_BODY       (32u * 1024u * 1024u) /* 32 MiB request cap */

typedef struct {
    int         port;
    const char *webroot;    /* frontend/ static root */
    const char *datadir;    /* data/ persistent state */
    const char *pkgdir;     /* packages/ repository */
    const char *srcdir;     /* project root, for source export */
    const char *logdir;     /* data/logs */
    int         workers;    /* thread pool size */
    int         backlog;
    char        token[65];  /* local session token (hex) */
} server_config_t;

typedef struct {
    char method[16];
    char path[LUME_MAX_PATH];
    char query[1024];
    char version[16];

    /* parsed headers of interest */
    char content_type[256];
    char auth[256];          /* raw Authorization header */
    char token[128];         /* X-Lume-Token value */
    char host[256];
    char origin[256];

    char  *body;
    size_t body_len;
} http_request_t;

typedef struct {
    int    status;
    char   content_type[128];
    char  *body;
    size_t body_len;
    /* when set, body is served from a file descriptor-like path */
    int    is_file;
    char   file_path[LUME_MAX_PATH];
    long   file_offset;
    long   file_length;
    char   extra_headers[512];
} http_response_t;

/* Response helpers (routes.c / files.c use these). */
void resp_init(http_response_t *res);
void resp_free(http_response_t *res);
void resp_text(http_response_t *res, int status, const char *body);
void resp_json(http_response_t *res, int status, const char *json);
void resp_error(http_response_t *res, int status, const char *message);
void resp_file(http_response_t *res, const char *path, const char *mime, long len);

/* Server entry points (main.c). */
int  lume_server_run(const server_config_t *cfg);

/* Router (routes.c). */
void lume_route(const server_config_t *cfg, const http_request_t *req,
                http_response_t *res);

#endif /* LUME_SERVER_H */
