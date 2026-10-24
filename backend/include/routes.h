/*
 * LumeOS - backend/include/routes.h
 * API route handlers implemented across files.c and system.c.
 */
#ifndef LUME_ROUTES_H
#define LUME_ROUTES_H

#include "server.h"

/* ---- files.c : CRUD mapped to data/files/ ---- */
void handle_files_list(const server_config_t *cfg, const http_request_t *req,
                       http_response_t *res);
void handle_files_read(const server_config_t *cfg, const http_request_t *req,
                       http_response_t *res);
void handle_files_write(const server_config_t *cfg, const http_request_t *req,
                        http_response_t *res);
void handle_files_delete(const server_config_t *cfg, const http_request_t *req,
                         http_response_t *res);
void handle_files_mkdir(const server_config_t *cfg, const http_request_t *req,
                        http_response_t *res);

/* ---- system.c : telemetry, packages, native exec, source export ---- */
void handle_system_info(const server_config_t *cfg, const http_request_t *req,
                        http_response_t *res);
void handle_packages_list(const server_config_t *cfg, const http_request_t *req,
                          http_response_t *res);
void handle_exec_native(const server_config_t *cfg, const http_request_t *req,
                        http_response_t *res);
void handle_export_project(const server_config_t *cfg, const http_request_t *req,
                           http_response_t *res);
void handle_health(const server_config_t *cfg, const http_request_t *req,
                   http_response_t *res);

/* ---- static serving (routes.c) ---- */
void handle_static(const server_config_t *cfg, const http_request_t *req,
                   http_response_t *res);

/* Utility: read a JSON string field value from a flat JSON body. */
int json_get_string(const char *json, const char *key, char *out, size_t outsz);

/* Utility: read a query-string parameter (?k=v&...). Returns 0 on found. */
int query_get(const char *query, const char *key, char *out, size_t outsz);

#endif /* LUME_ROUTES_H */
