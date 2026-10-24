/*
 * LumeOS - backend/include/security.h
 * Path-traversal protection, token authentication and CORS.
 */
#ifndef LUME_SECURITY_H
#define LUME_SECURITY_H

#include "server.h"

/*
 * Resolve `requested` (a URL path) safely against `root`.
 * On success writes the canonical absolute path into `out` (size `outsz`)
 * and returns 0. Returns -1 if the path escapes `root`, contains illegal
 * traversal, or cannot be resolved.
 */
int lume_secure_path(const char *root, const char *requested,
                     char *out, size_t outsz);

/* Percent-decode `in` into `out`. Returns 0 on success, -1 on malformed. */
int lume_url_decode(const char *in, char *out, size_t outsz);

/* Validate a session token supplied by a client against the server token.
 * Returns 1 if authorised, 0 otherwise. Uses constant-time comparison. */
int lume_token_authorized(const server_config_t *cfg, const http_request_t *req);

/* Fill `res` extra_headers with permissive-but-safe CORS + security headers. */
void lume_apply_security_headers(const server_config_t *cfg,
                                 const http_request_t *req,
                                 http_response_t *res);

/* Generate a random hex token of `bytes` entropy into `out` (needs 2*bytes+1). */
void lume_generate_token(size_t bytes, char *out, size_t outsz);

#endif /* LUME_SECURITY_H */
