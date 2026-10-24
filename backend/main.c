/*
 * LumeOS - backend/main.c
 * Multi-threaded POSIX HTTP/1.1 server.
 *
 * Architecture:
 *   - one listener socket bound to cfg->port
 *   - a bounded thread pool of `workers` threads consuming accepted
 *     connections from a mutex/cond protected queue
 *   - each connection is parsed once and dispatched through lume_route()
 *
 * Build: -std=c11 -Wall -Wextra -O2 -pthread
 */
#define _POSIX_C_SOURCE 200809L

#include "server.h"
#include "routes.h"
#include "security.h"
#include "core.h"

#include <arpa/inet.h>
#include <errno.h>
#include <netinet/in.h>
#include <pthread.h>
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <sys/time.h>
#include <unistd.h>

/* ================================================================== */
/* Connection queue (bounded, ring buffer)                             */
/* ================================================================== */
typedef struct {
    int  *items;
    int   cap;
    int   head;
    int   tail;
    int   count;
    int   closed;
    pthread_mutex_t mu;
    pthread_cond_t  not_empty;
    pthread_cond_t  not_full;
} conn_queue_t;

static conn_queue_t g_queue;

static void queue_init(conn_queue_t *q, int cap) {
    q->items = calloc((size_t)cap, sizeof(int));
    q->cap = cap;
    q->head = q->tail = q->count = 0;
    q->closed = 0;
    pthread_mutex_init(&q->mu, NULL);
    pthread_cond_init(&q->not_empty, NULL);
    pthread_cond_init(&q->not_full, NULL);
}

static int queue_push(conn_queue_t *q, int fd) {
    pthread_mutex_lock(&q->mu);
    while (q->count == q->cap && !q->closed)
        pthread_cond_wait(&q->not_full, &q->mu);
    if (q->closed) { pthread_mutex_unlock(&q->mu); return -1; }
    q->items[q->tail] = fd;
    q->tail = (q->tail + 1) % q->cap;
    q->count++;
    pthread_cond_signal(&q->not_empty);
    pthread_mutex_unlock(&q->mu);
    return 0;
}

static int queue_pop(conn_queue_t *q, int *fd) {
    pthread_mutex_lock(&q->mu);
    while (q->count == 0 && !q->closed)
        pthread_cond_wait(&q->not_empty, &q->mu);
    if (q->count == 0 && q->closed) { pthread_mutex_unlock(&q->mu); return -1; }
    *fd = q->items[q->head];
    q->head = (q->head + 1) % q->cap;
    q->count--;
    pthread_cond_signal(&q->not_full);
    pthread_mutex_unlock(&q->mu);
    return 0;
}

static void queue_close(conn_queue_t *q) {
    pthread_mutex_lock(&q->mu);
    q->closed = 1;
    pthread_cond_broadcast(&q->not_empty);
    pthread_cond_broadcast(&q->not_full);
    pthread_mutex_unlock(&q->mu);
}

/* ================================================================== */
/* I/O helpers                                                         */
/* ================================================================== */
static int send_all(int fd, const void *buf, size_t len) {
    const char *p = (const char *)buf;
    size_t sent = 0;
    while (sent < len) {
        ssize_t n = send(fd, p + sent, len - sent, MSG_NOSIGNAL);
        if (n < 0) {
            if (errno == EINTR) continue;
            return -1;
        }
        if (n == 0) return -1;
        sent += (size_t)n;
    }
    return 0;
}

/* Read exactly the request headers up to and including \r\n\r\n.
 * Returns total bytes read, or -1. Leaves any surplus (body start) in
 * `buf` and reports it via *surplus. */
static ssize_t read_headers(int fd, char *buf, size_t cap, size_t *surplus) {
    size_t total = 0;
    *surplus = 0;
    while (total < cap - 1) {
        ssize_t n = recv(fd, buf + total, cap - 1 - total, 0);
        if (n < 0) {
            if (errno == EINTR) continue;
            return -1;
        }
        if (n == 0) break;
        total += (size_t)n;
        buf[total] = '\0';
        char *end = strstr(buf, "\r\n\r\n");
        if (end) {
            *surplus = total - (size_t)(end + 4 - buf);
            return (ssize_t)total;
        }
    }
    buf[total] = '\0';
    return (ssize_t)total;
}

/* ================================================================== */
/* Request parsing                                                     */
/* ================================================================== */
static char *trim(char *s) { return lume_trim(s); }

static int parse_request(const server_config_t *cfg, int fd,
                         http_request_t *req) {
    memset(req, 0, sizeof(*req));

    char hdr[LUME_MAX_HEADER_LEN];
    size_t surplus = 0;
    ssize_t total = read_headers(fd, hdr, sizeof(hdr), &surplus);
    if (total <= 0) return -1;

    /* ---- request line ---- */
    char *line_end = strstr(hdr, "\r\n");
    if (!line_end) return -1;
    *line_end = '\0';
    char *line = hdr;

    char *save = NULL;
    char *method = strtok_r(line, " ", &save);
    char *target = strtok_r(NULL, " ", &save);
    char *version = strtok_r(NULL, " ", &save);
    if (!method || !target) return -1;

    snprintf(req->method, sizeof(req->method), "%s", method);
    snprintf(req->version, sizeof(req->version), "%s", version ? version : "HTTP/1.0");

    /* split path?query */
    char *q = strchr(target, '?');
    if (q) {
        *q = '\0';
        snprintf(req->query, sizeof(req->query), "%s", q + 1);
    }
    /* decode the path (so %20 etc. resolve before containment checks) */
    char decoded[LUME_MAX_PATH];
    if (lume_url_decode(target, decoded, sizeof(decoded)) == 0)
        snprintf(req->path, sizeof(req->path), "%s", decoded);
    else
        snprintf(req->path, sizeof(req->path), "%s", target);

    /* ---- headers ---- */
    char *cursor = line_end + 2;
    char *body_start = strstr(cursor, "\r\n\r\n");
    /* Capture the body pointer BEFORE the header loop mutates the buffer
     * (it writes '\0' over CRLFs, which would destroy the \r\n\r\n marker). */
    char *body_ptr = body_start ? body_start + 4 : NULL;
    size_t content_length = 0;
    while (cursor && *cursor && cursor < (body_start ? body_start : hdr + total)) {
        char *eol = strstr(cursor, "\r\n");
        if (!eol) break;
        *eol = '\0';
        char *colon = strchr(cursor, ':');
        if (colon) {
            *colon = '\0';
            char *name = trim(cursor);
            char *value = trim(colon + 1);
            if (lume_str_ieq(name, "Content-Length")) {
                content_length = (size_t)strtoul(value, NULL, 10);
            } else if (lume_str_ieq(name, "Content-Type")) {
                snprintf(req->content_type, sizeof(req->content_type), "%s", value);
            } else if (lume_str_ieq(name, "X-Lume-Token")) {
                snprintf(req->token, sizeof(req->token), "%s", value);
            } else if (lume_str_ieq(name, "Authorization")) {
                snprintf(req->auth, sizeof(req->auth), "%s", value);
            } else if (lume_str_ieq(name, "Host")) {
                snprintf(req->host, sizeof(req->host), "%s", value);
            } else if (lume_str_ieq(name, "Origin")) {
                snprintf(req->origin, sizeof(req->origin), "%s", value);
            }
        }
        cursor = eol + 2;
    }

    /* ---- body ---- */
    if (content_length > 0) {
        if (content_length > LUME_MAX_BODY) {
            return -2; /* too large; caller answers 413 */
        }
        char *body = malloc(content_length + 1);
        if (!body) return -1;
        size_t have = surplus;
        if (have > content_length) have = content_length;
        if (have > 0 && body_ptr) {
            /* surplus bytes were already read past the header block */
            memcpy(body, body_ptr, have);
        }
        while (have < content_length) {
            ssize_t n = recv(fd, body + have, content_length - have, 0);
            if (n <= 0) { free(body); return -1; }
            have += (size_t)n;
        }
        body[content_length] = '\0';
        req->body = body;
        req->body_len = content_length;
    }
    (void)cfg;
    return 0;
}

/* ================================================================== */
/* Response writing                                                    */
/* ================================================================== */
static const char *status_text(int code) {
    switch (code) {
        case 200: return "OK";
        case 204: return "No Content";
        case 400: return "Bad Request";
        case 401: return "Unauthorized";
        case 403: return "Forbidden";
        case 404: return "Not Found";
        case 405: return "Method Not Allowed";
        case 409: return "Conflict";
        case 413: return "Payload Too Large";
        case 500: return "Internal Server Error";
        default:  return "OK";
    }
}

static int write_response(const server_config_t *cfg, const http_request_t *req,
                          http_response_t *res, int fd) {
    char head[2048];
    long body_len = 0;

    if (res->is_file) {
        struct stat st;
        if (stat(res->file_path, &st) != 0) return -1;
        body_len = (res->file_length >= 0) ? res->file_length : (long)st.st_size;
    } else {
        body_len = (long)res->body_len;
    }

    int is_head = lume_str_ieq(req->method, "HEAD");

    int n = snprintf(head, sizeof(head),
        "HTTP/1.1 %d %s\r\n"
        "Content-Type: %s\r\n"
        "Content-Length: %ld\r\n"
        "Connection: close\r\n"
        "Server: LumeOS/%s\r\n"
        "%s"
        "\r\n",
        res->status, status_text(res->status),
        res->content_type, body_len,
        LUME_VERSION,
        res->extra_headers);

    if (n < 0 || n >= (int)sizeof(head)) return -1;
    if (send_all(fd, head, (size_t)n) != 0) return -1;

    if (is_head || res->status == 204) return 0;

    if (res->is_file) {
        FILE *f = fopen(res->file_path, "rb");
        if (!f) return -1;
        if (res->file_offset > 0) fseek(f, res->file_offset, SEEK_SET);
        char buf[65536];
        long remaining = body_len;
        while (remaining > 0) {
            size_t want = (remaining > (long)sizeof(buf)) ? sizeof(buf) : (size_t)remaining;
            size_t rd = fread(buf, 1, want, f);
            if (rd == 0) break;
            if (send_all(fd, buf, rd) != 0) { fclose(f); return -1; }
            remaining -= (long)rd;
        }
        fclose(f);
    } else if (res->body && res->body_len) {
        if (send_all(fd, res->body, res->body_len) != 0) return -1;
    }
    (void)cfg;
    return 0;
}

/* ================================================================== */
/* Per-connection handling                                             */
/* ================================================================== */
static void handle_connection(const server_config_t *cfg, int fd) {
    /* Receive timeout so a stalled client cannot pin a worker forever. */
    struct timeval tv = { .tv_sec = 15, .tv_usec = 0 };
    setsockopt(fd, SOL_SOCKET, SO_RCVTIMEO, &tv, sizeof(tv));
    setsockopt(fd, SOL_SOCKET, SO_SNDTIMEO, &tv, sizeof(tv));

    http_request_t req;
    http_response_t res;
    resp_init(&res);

    int rc = parse_request(cfg, fd, &req);
    if (rc == -2) {
        lume_apply_security_headers(cfg, &req, &res);
        resp_error(&res, 413, "request body too large");
        write_response(cfg, &req, &res, fd);
    } else if (rc != 0) {
        resp_error(&res, 400, "malformed request");
        write_response(cfg, &req, &res, fd);
    } else {
        lume_route(cfg, &req, &res);
        lume_apply_security_headers(cfg, &req, &res);
        write_response(cfg, &req, &res, fd);
    }

    resp_free(&res);
    if (req.body) free(req.body);
}

/* ================================================================== */
/* Worker threads                                                      */
/* ================================================================== */
typedef struct {
    const server_config_t *cfg;
} worker_arg_t;

static void *worker_main(void *arg) {
    worker_arg_t *wa = (worker_arg_t *)arg;
    const server_config_t *cfg = wa->cfg;

    for (;;) {
        int fd;
        if (queue_pop(&g_queue, &fd) != 0) break;
        handle_connection(cfg, fd);
        close(fd);
    }
    return NULL;
}

/* ================================================================== */
/* Lifecycle                                                           */
/* ================================================================== */
static volatile sig_atomic_t g_stop = 0;
static int g_listen_fd = -1;

static void on_signal(int sig) {
    (void)sig;
    g_stop = 1;
    if (g_listen_fd >= 0) {
        shutdown(g_listen_fd, SHUT_RDWR);
        close(g_listen_fd);
        g_listen_fd = -1;
    }
}

static void ensure_dirs(const server_config_t *cfg) {
    char p[LUME_MAX_PATH];
    const char *subs[] = { "files", "logs", "database", "models" };
    for (size_t i = 0; i < sizeof(subs) / sizeof(subs[0]); ++i) {
        snprintf(p, sizeof(p), "%s/%s", cfg->datadir, subs[i]);
        lume_mkdir_p(p);
    }
    lume_mkdir_p(cfg->pkgdir);
}

int lume_server_run(const server_config_t *cfg) {
    ensure_dirs(cfg);

    signal(SIGPIPE, SIG_IGN);
    signal(SIGINT, on_signal);
    signal(SIGTERM, on_signal);

    g_listen_fd = socket(AF_INET, SOCK_STREAM, 0);
    if (g_listen_fd < 0) { LOG_ERROR("socket() failed: %s", strerror(errno)); return 1; }

    int opt = 1;
    setsockopt(g_listen_fd, SOL_SOCKET, SO_REUSEADDR, &opt, sizeof(opt));

    struct sockaddr_in addr;
    memset(&addr, 0, sizeof(addr));
    addr.sin_family = AF_INET;
    addr.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
    addr.sin_port = htons((uint16_t)cfg->port);

    if (bind(g_listen_fd, (struct sockaddr *)&addr, sizeof(addr)) != 0) {
        LOG_ERROR("bind(:%d) failed: %s", cfg->port, strerror(errno));
        close(g_listen_fd);
        g_listen_fd = -1;
        return 1;
    }
    if (listen(g_listen_fd, cfg->backlog) != 0) {
        LOG_ERROR("listen() failed: %s", strerror(errno));
        close(g_listen_fd);
        g_listen_fd = -1;
        return 1;
    }

    /* Thread pool */
    int nworkers = cfg->workers > 0 ? cfg->workers : 4;
    queue_init(&g_queue, 128);
    pthread_t *threads = calloc((size_t)nworkers, sizeof(pthread_t));
    worker_arg_t wa = { .cfg = cfg };
    for (int i = 0; i < nworkers; ++i)
        pthread_create(&threads[i], NULL, worker_main, &wa);

    LOG_INFO("LumeOS %s listening on http://127.0.0.1:%d  (workers=%d, webroot=%s)",
             LUME_VERSION, cfg->port, nworkers, cfg->webroot);
    if (cfg->token[0])
        LOG_INFO("session token: %s", cfg->token);
    else
        LOG_WARN("session token disabled (writes are unprotected)");

    /* Accept loop */
    while (!g_stop) {
        struct sockaddr_in cli;
        socklen_t clen = sizeof(cli);
        int fd = accept(g_listen_fd, (struct sockaddr *)&cli, &clen);
        if (fd < 0) {
            if (errno == EINTR) continue;
            if (g_stop) break;
            LOG_WARN("accept() failed: %s", strerror(errno));
            continue;
        }
        if (queue_push(&g_queue, fd) != 0) {
            close(fd);
            break;
        }
    }

    LOG_INFO("shutting down...");
    queue_close(&g_queue);
    for (int i = 0; i < nworkers; ++i) pthread_join(threads[i], NULL);
    free(threads);
    free(g_queue.items);
    if (g_listen_fd >= 0) { close(g_listen_fd); g_listen_fd = -1; }
    return 0;
}

/* ================================================================== */
/* Entry point                                                         */
/* ================================================================== */
static void usage(const char *prog) {
    printf(
        "LumeOS %s - hybrid web-desktop OS server\n\n"
        "Usage: %s [options]\n\n"
        "Options:\n"
        "  -p, --port <n>      TCP port to listen on (default 8080)\n"
        "      --webroot <dir> static frontend root (default frontend)\n"
        "      --data <dir>    persistent data dir (default data)\n"
        "      --packages <d>  package repository dir (default packages)\n"
        "      --root <dir>    project root for source export (default .)\n"
        "      --workers <n>   thread pool size (default 4)\n"
        "      --token <hex>   require X-Lume-Token on write endpoints\n"
        "      --secure        generate a random session token and print it\n"
        "      --verbose       enable debug logging\n"
        "  -h, --help          show this help\n"
        "  -v, --version       show version\n",
        LUME_VERSION, prog);
}

int main(int argc, char **argv) {
    server_config_t cfg;
    memset(&cfg, 0, sizeof(cfg));
    cfg.port    = 8080;
    cfg.backlog = 128;
    cfg.workers = 4;
    cfg.webroot = "frontend";
    cfg.datadir = "data";
    cfg.pkgdir  = "packages";
    cfg.srcdir  = ".";
    cfg.logdir  = "data/logs";

    for (int i = 1; i < argc; ++i) {
        const char *a = argv[i];
        if ((strcmp(a, "--port") == 0 || strcmp(a, "-p") == 0) && i + 1 < argc)
            cfg.port = atoi(argv[++i]);
        else if (strcmp(a, "--webroot") == 0 && i + 1 < argc)
            cfg.webroot = argv[++i];
        else if (strcmp(a, "--data") == 0 && i + 1 < argc)
            cfg.datadir = argv[++i];
        else if (strcmp(a, "--packages") == 0 && i + 1 < argc)
            cfg.pkgdir = argv[++i];
        else if (strcmp(a, "--root") == 0 && i + 1 < argc)
            cfg.srcdir = argv[++i];
        else if (strcmp(a, "--workers") == 0 && i + 1 < argc)
            cfg.workers = atoi(argv[++i]);
        else if (strcmp(a, "--token") == 0 && i + 1 < argc)
            snprintf(cfg.token, sizeof(cfg.token), "%s", argv[++i]);
        else if (strcmp(a, "--secure") == 0)
            lume_generate_token(32, cfg.token, sizeof(cfg.token));
        else if (strcmp(a, "--verbose") == 0)
            lume_log_set_level(LUME_LOG_DEBUG);
        else if (strcmp(a, "--version") == 0 || strcmp(a, "-v") == 0) {
            printf("LumeOS %s\n", LUME_VERSION);
            return 0;
        } else if (strcmp(a, "--help") == 0 || strcmp(a, "-h") == 0) {
            usage(argv[0]);
            return 0;
        } else {
            fprintf(stderr, "unknown option: %s\n", a);
            usage(argv[0]);
            return 2;
        }
    }

    if (cfg.workers < 1) cfg.workers = 1;
    if (cfg.workers > 64) cfg.workers = 64;
    if (cfg.port < 1 || cfg.port > 65535) {
        fprintf(stderr, "invalid port: %d\n", cfg.port);
        return 2;
    }

    LOG_INFO("starting LumeOS server...");
    return lume_server_run(&cfg);
}
