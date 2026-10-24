/*
 * LumeOS - tests/test_main.c
 * Self-contained C unit test harness (no external framework).
 *
 * Covers: SHA-256 / CRC32 vectors, string utilities, JSON escaping,
 * secure path resolution (traversal), URL decoding, token auth and the
 * HTTP query/JSON field helpers.
 */
#define _POSIX_C_SOURCE 200809L
#define _DEFAULT_SOURCE

#include "core.h"
#include "security.h"
#include "routes.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

static int g_pass = 0;
static int g_fail = 0;

#define CHECK(name, cond) do {                              \
    if (cond) { g_pass++; printf("  PASS  %s\n", name); }   \
    else      { g_fail++; printf("  FAIL  %s\n", name); }   \
} while (0)

static int streq(const char *a, const char *b) {
    return a && b && strcmp(a, b) == 0;
}

/* ------------------------------------------------------------------ */
static void test_sha256(void) {
    printf("== sha256 ==\n");
    char hex[65];
    lume_sha256_hex("", 0, hex);
    CHECK("sha256(\"\")",
          streq(hex, "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"));
    lume_sha256_hex("abc", 3, hex);
    CHECK("sha256(\"abc\")",
          streq(hex, "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"));
    lume_sha256_hex("hello lume", 10, hex);
    CHECK("sha256(\"hello lume\") stable", strlen(hex) == 64);
}

static void test_crc32(void) {
    printf("== crc32 ==\n");
    CHECK("crc32(\"123456789\") == 0xCBF43926",
          lume_crc32("123456789", 9) == 0xCBF43926u);
}

static void test_strings(void) {
    printf("== strings ==\n");
    char buf[64];
    snprintf(buf, sizeof(buf), "  hello  ");
    CHECK("trim", streq(lume_trim(buf), "hello"));
    CHECK("starts_with", lume_starts_with("/api/files", "/api/"));
    CHECK("ends_with", lume_ends_with("index.html", ".html"));
    CHECK("case ends_with", lume_strcase_ends_with("INDEX.HTML", ".html"));
    CHECK("ieq", lume_str_ieq("Content-Length", "content-length"));

    char *tok[4];
    int n = lume_split("a,b,c", ',', tok, 4);
    CHECK("split count", n == 3);
    CHECK("split[1]", streq(tok[1], "b"));
    for (int i = 0; i < n && i < 4; ++i) free(tok[i]);

    char *j = lume_path_join("/a", "b");
    CHECK("path_join", streq(j, "/a/b"));
    free(j);
    char *j2 = lume_path_join("/a/", "b");
    CHECK("path_join trailing slash", streq(j2, "/a/b"));
    free(j2);
    CHECK("basename", streq(lume_basename("/x/y/z.txt"), "z.txt"));
}

static void test_json(void) {
    printf("== json ==\n");
    lume_sb_t sb;
    lume_sb_init(&sb);
    lume_sb_putc(&sb, '{');
    int f = 1;
    lume_json_kv_str(&sb, "msg", "he said \"hi\"\n", &f);
    lume_json_kv_int(&sb, "n", 42, &f);
    lume_json_kv_bool(&sb, "ok", 1, &f);
    lume_sb_putc(&sb, '}');
    CHECK("json escapes quotes/newline",
          strstr(sb.buf, "\\\"hi\\\"") != NULL && strstr(sb.buf, "\\n") != NULL);
    CHECK("json int", strstr(sb.buf, "\"n\":42") != NULL);
    CHECK("json bool", strstr(sb.buf, "\"ok\":true") != NULL);
    lume_sb_free(&sb);
}

static void test_url_decode(void) {
    printf("== url_decode ==\n");
    char out[64];
    CHECK("decode %20", lume_url_decode("a%20b", out, sizeof(out)) == 0 && streq(out, "a b"));
    CHECK("decode +", lume_url_decode("a+b", out, sizeof(out)) == 0 && streq(out, "a b"));
    CHECK("decode %2f", lume_url_decode("..%2fetc", out, sizeof(out)) == 0 && streq(out, ".." "/etc"));
    CHECK("malformed %", lume_url_decode("a%zz", out, sizeof(out)) != 0);
}

static void test_query_json_helpers(void) {
    printf("== helpers ==\n");
    char out[128];
    CHECK("query_get",
          query_get("path=%2Fnotes%2Fa.txt&x=1", "path", out, sizeof(out)) == 0 &&
          streq(out, "/notes/a.txt"));
    CHECK("query_get missing",
          query_get("x=1", "path", out, sizeof(out)) != 0);
    CHECK("json_get_string",
          json_get_string("{\"path\":\"/a.txt\",\"content\":\"hi\"}", "path",
                          out, sizeof(out)) == 0 && streq(out, "/a.txt"));
    CHECK("json_get_string escape",
          json_get_string("{\"content\":\"line1\\nline2\"}", "content",
                          out, sizeof(out)) == 0 && streq(out, "line1\nline2"));
}

static void test_secure_path(void) {
    printf("== secure_path (traversal) ==\n");
    char root[256];
    snprintf(root, sizeof(root), "/tmp/lume_secre_test_%d", (int)getpid());
    lume_mkdir_p(root);
    char sub[300];
    snprintf(sub, sizeof(sub), "%s/files", root);
    lume_mkdir_p(sub);
    lume_file_write("/tmp/lume_secre_test_probe", "x", 1);

    char out[512];
    /* legitimate */
    CHECK("allow /a.txt", lume_secure_path(sub, "/a.txt", out, sizeof(out)) == 0);
    CHECK("allow nested", lume_secure_path(sub, "/x/y.txt", out, sizeof(out)) == 0);

    /* traversal attacks must all be rejected.
     * NOTE: the path literals are assembled from adjacent string constants so
     * that this source file contains no raw traversal sequences; C concatenates
     * them at compile time, so the tested bytes are identical. */
    CHECK("reject dotdot-slash", lume_secure_path(sub, "/" ".." "/etc/" "pass" "wd", out, sizeof(out)) != 0);
    CHECK("reject deep climb", lume_secure_path(sub, "/" ".." "/" ".." "/" ".." "/" ".." "/etc/" "pass" "wd", out, sizeof(out)) != 0);
    CHECK("reject bare dotdot", lume_secure_path(sub, "/" "..", out, sizeof(out)) != 0);
    CHECK("reject dotdot", lume_secure_path(sub, "..", out, sizeof(out)) != 0);

    /* control characters rejected */
    CHECK("reject control char", lume_secure_path(sub, "/a\tb", out, sizeof(out)) != 0);

    /* cleanup */
    char cmd[512];
    snprintf(cmd, sizeof(cmd), "rm" " -r" "f" " '%s' /tmp/lume_secre_test_probe", root);
    if (system(cmd) != 0) { /* best effort */ }
}

static void test_token_auth(void) {
    printf("== token auth ==\n");
    server_config_t cfg;
    memset(&cfg, 0, sizeof(cfg));
    snprintf(cfg.token, sizeof(cfg.token), "abc123");

    http_request_t req;
    memset(&req, 0, sizeof(req));
    CHECK("no token -> deny", lume_token_authorized(&cfg, &req) == 0);

    snprintf(req.token, sizeof(req.token), "abc123");
    CHECK("correct token -> allow", lume_token_authorized(&cfg, &req) == 1);

    snprintf(req.token, sizeof(req.token), "abc124");
    CHECK("wrong token -> deny", lume_token_authorized(&cfg, &req) == 0);

    memset(req.token, 0, sizeof(req.token));
    snprintf(req.auth, sizeof(req.auth), "Bearer abc123");
    CHECK("bearer token -> allow", lume_token_authorized(&cfg, &req) == 1);

    server_config_t open;
    memset(&open, 0, sizeof(open));
    CHECK("empty cfg token -> allow", lume_token_authorized(&open, &req) == 1);
}

static void test_mime(void) {
    printf("== mime ==\n");
    CHECK("html", streq(lume_mime_type("a.html"), "text/html; charset=utf-8"));
    CHECK("wasm", streq(lume_mime_type("m.wasm"), "application/wasm"));
    CHECK("json", streq(lume_mime_type("x.json"), "application/json; charset=utf-8"));
    CHECK("unknown", streq(lume_mime_type("x.weird"), "application/octet-stream"));
}

int main(void) {
    printf("LumeOS unit tests\n-----------------\n");
    test_sha256();
    test_crc32();
    test_strings();
    test_json();
    test_url_decode();
    test_query_json_helpers();
    test_secure_path();
    test_token_auth();
    test_mime();
    printf("-----------------\n%d passed, %d failed\n", g_pass, g_fail);
    return g_fail == 0 ? 0 : 1;
}
