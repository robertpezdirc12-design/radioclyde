/* ldshim.c -- LD_PRELOAD path redirect for the userspace Liquidsoap harness
 * (scripts/fetch-liquidsoap.mjs, docs/liquidsoap-upgrade.md).
 *
 * WHY THIS EXISTS: Liquidsoap 2.2.x hardcodes /usr/share/liquidsoap for its
 * stdlib .liq files, so the binary extracted from the official Docker image
 * into a userspace rootfs cannot find them (the real /usr/share/liquidsoap on
 * the host either does not exist or belongs to a DIFFERENT liquidsoap). This
 * shim interposes the libc path calls and rewrites any path under the
 * captured prefix to <LDSHIM_PREFIX>/<original path>, letting the binary run
 * against the image's own stdlib without root, without docker, and without
 * touching the host filesystem.
 *
 * 2.4.x does NOT need this shim: it accepts --stdlib <file>, so the wrapper
 * script points it straight at the rootfs copy (Runtime.libs wants the FILE
 * stdlib.liq, not the directory -- discovered on the real binary 2026-10-24).
 *
 * BUILD: gcc -shared -fPIC -O2 -o ldshim.so scripts/ldshim.c
 * USE:   LDSHIM_PREFIX=/path/to/rootfs LD_PRELOAD=/path/to/ldshim.so \
 *          <rootfs-loader> --library-path <rootfs-libs> \
 *          <rootfs>/usr/bin/liquidsoap --check radio.liq
 *
 * Only the four call families the 2.2.4 stdlib loader actually exercises are
 * interposed (open/stat/access/mkdir, per the 2026-10-24 live run), plus
 * their at/64/xstat variants and opendir/fopen as cheap insurance -- every
 * wrapper passes everything else through untouched. Paths that do not start
 * with a captured prefix are returned as-is, so the process's OWN files
 * (config.json under RADIOCLYDE_HOME, m3u playlists, helper scripts) keep
 * their real host paths: only the engine's self-located stdlib moves.
 *
 * This file reconstructs the shim used for the 2026-10-24 validation
 * (referenced by docs/liquidsoap-upgrade.md but never committed then); it
 * was re-verified against both official images on 2026-10-27 by
 * scripts/fetch-liquidsoap.mjs's self-test (run.sh --version).
 */

#define _GNU_SOURCE
#include <dlfcn.h>
#include <fcntl.h>
#include <limits.h>
#include <stdarg.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <sys/types.h>
#include <unistd.h>
#include <dirent.h>

/* Paths the 2.2.x binary hardcodes for its own stdlib. Extend ONLY with
 * prefixes that verifiably cannot be passed via a command-line flag --
 * everything the host legitimately owns stays un-redirected. */
static const char *const kCaptured[] = {
    "/usr/share/liquidsoap",
    NULL,
};

static const char *shim_prefix(void) {
  const char *p = getenv("LDSHIM_PREFIX");
  return (p && *p) ? p : NULL;
}

/* Returns `path` unchanged, or a rewritten copy in `buf` (caller-provided,
 * PATH_MAX) when the path sits under a captured prefix. `buf` is only valid
 * until the caller's next call into redirect(). */
static const char *redirect(const char *path, char buf[PATH_MAX]) {
  if (!path || path[0] != '/')
    return path;
  const char *pfx = shim_prefix();
  if (!pfx)
    return path;
  for (int i = 0; kCaptured[i]; i++) {
    size_t n = strlen(kCaptured[i]);
    if (strncmp(path, kCaptured[i], n) == 0 &&
        (path[n] == '\0' || path[n] == '/')) {
      int w = snprintf(buf, PATH_MAX, "%s%s", pfx, path);
      if (w < 0 || (size_t)w >= PATH_MAX)
        return path; /* too long: fall through to the honest host path */
      return buf;
    }
  }
  return path;
}

/* ---- open / open64 ------------------------------------------------------- */

int open(const char *path, int flags, ...) {
  static int (*real)(const char *, int, ...);
  if (!real)
    real = (int (*)(const char *, int, ...))dlsym(RTLD_NEXT, "open");
  char buf[PATH_MAX];
  mode_t mode = 0;
  if (flags & O_CREAT) {
    va_list ap;
    va_start(ap, flags);
    mode = (mode_t)va_arg(ap, int);
    va_end(ap);
  }
  return real(redirect(path, buf), flags, mode);
}

int open64(const char *path, int flags, ...) {
  static int (*real)(const char *, int, ...);
  if (!real)
    real = (int (*)(const char *, int, ...))dlsym(RTLD_NEXT, "open64");
  char buf[PATH_MAX];
  mode_t mode = 0;
  if (flags & O_CREAT) {
    va_list ap;
    va_start(ap, flags);
    mode = (mode_t)va_arg(ap, int);
    va_end(ap);
  }
  return real(redirect(path, buf), flags, mode);
}

/* ---- openat / openat64 --------------------------------------------------- */

int openat(int dirfd, const char *path, int flags, ...) {
  static int (*real)(int, const char *, int, ...);
  if (!real)
    real = (int (*)(int, const char *, int, ...))dlsym(RTLD_NEXT, "openat");
  char buf[PATH_MAX];
  mode_t mode = 0;
  if (flags & O_CREAT) {
    va_list ap;
    va_start(ap, flags);
    mode = (mode_t)va_arg(ap, int);
    va_end(ap);
  }
  return real(dirfd, redirect(path, buf), flags, mode);
}

int openat64(int dirfd, const char *path, int flags, ...) {
  static int (*real)(int, const char *, int, ...);
  if (!real)
    real = (int (*)(int, const char *, int, ...))dlsym(RTLD_NEXT, "openat64");
  char buf[PATH_MAX];
  mode_t mode = 0;
  if (flags & O_CREAT) {
    va_list ap;
    va_start(ap, flags);
    mode = (mode_t)va_arg(ap, int);
    va_end(ap);
  }
  return real(dirfd, redirect(path, buf), flags, mode);
}

/* ---- stat family --------------------------------------------------------- */

int stat(const char *path, struct stat *st) {
  static int (*real)(const char *, struct stat *);
  if (!real)
    real = (int (*)(const char *, struct stat *))dlsym(RTLD_NEXT, "stat");
  char buf[PATH_MAX];
  return real(redirect(path, buf), st);
}

int stat64(const char *path, struct stat64 *st) {
  static int (*real)(const char *, struct stat64 *);
  if (!real)
    real = (int (*)(const char *, struct stat64 *))dlsym(RTLD_NEXT, "stat64");
  char buf[PATH_MAX];
  return real(redirect(path, buf), st);
}

int lstat(const char *path, struct stat *st) {
  static int (*real)(const char *, struct stat *);
  if (!real)
    real = (int (*)(const char *, struct stat *))dlsym(RTLD_NEXT, "lstat");
  char buf[PATH_MAX];
  return real(redirect(path, buf), st);
}

int lstat64(const char *path, struct stat64 *st) {
  static int (*real)(const char *, struct stat64 *);
  if (!real)
    real = (int (*)(const char *, struct stat64 *))dlsym(RTLD_NEXT, "lstat64");
  char buf[PATH_MAX];
  return real(redirect(path, buf), st);
}

/* glibc < 2.33 routes stat through versioned __xstat symbols. */
int __xstat(int ver, const char *path, struct stat *st) {
  static int (*real)(int, const char *, struct stat *);
  if (!real)
    real = (int (*)(int, const char *, struct stat *))dlsym(RTLD_NEXT, "__xstat");
  char buf[PATH_MAX];
  return real(ver, redirect(path, buf), st);
}

int __xstat64(int ver, const char *path, struct stat64 *st) {
  static int (*real)(int, const char *, struct stat64 *);
  if (!real)
    real = (int (*)(int, const char *, struct stat64 *))dlsym(RTLD_NEXT, "__xstat64");
  char buf[PATH_MAX];
  return real(ver, redirect(path, buf), st);
}

int __lxstat(int ver, const char *path, struct stat *st) {
  static int (*real)(int, const char *, struct stat *);
  if (!real)
    real = (int (*)(int, const char *, struct stat *))dlsym(RTLD_NEXT, "__lxstat");
  char buf[PATH_MAX];
  return real(ver, redirect(path, buf), st);
}

int __lxstat64(int ver, const char *path, struct stat64 *st) {
  static int (*real)(int, const char *, struct stat64 *);
  if (!real)
    real = (int (*)(int, const char *, struct stat64 *))dlsym(RTLD_NEXT, "__lxstat64");
  char buf[PATH_MAX];
  return real(ver, redirect(path, buf), st);
}

int fstatat(int dirfd, const char *path, struct stat *st, int flags) {
  static int (*real)(int, const char *, struct stat *, int);
  if (!real)
    real = (int (*)(int, const char *, struct stat *, int))dlsym(RTLD_NEXT, "fstatat");
  char buf[PATH_MAX];
  return real(dirfd, redirect(path, buf), st, flags);
}

int fstatat64(int dirfd, const char *path, struct stat64 *st, int flags) {
  static int (*real)(int, const char *, struct stat64 *, int);
  if (!real)
    real = (int (*)(int, const char *, struct stat64 *, int))dlsym(RTLD_NEXT, "fstatat64");
  char buf[PATH_MAX];
  return real(dirfd, redirect(path, buf), st, flags);
}

/* ---- access -------------------------------------------------------------- */

int access(const char *path, int mode) {
  static int (*real)(const char *, int);
  if (!real)
    real = (int (*)(const char *, int))dlsym(RTLD_NEXT, "access");
  char buf[PATH_MAX];
  return real(redirect(path, buf), mode);
}

int faccessat(int dirfd, const char *path, int mode, int flags) {
  static int (*real)(int, const char *, int, int);
  if (!real)
    real = (int (*)(int, const char *, int, int))dlsym(RTLD_NEXT, "faccessat");
  char buf[PATH_MAX];
  return real(dirfd, redirect(path, buf), mode, flags);
}

/* ---- mkdir --------------------------------------------------------------- */

int mkdir(const char *path, mode_t mode) {
  static int (*real)(const char *, mode_t);
  if (!real)
    real = (int (*)(const char *, mode_t))dlsym(RTLD_NEXT, "mkdir");
  char buf[PATH_MAX];
  return real(redirect(path, buf), mode);
}

int mkdirat(int dirfd, const char *path, mode_t mode) {
  static int (*real)(int, const char *, mode_t);
  if (!real)
    real = (int (*)(int, const char *, mode_t))dlsym(RTLD_NEXT, "mkdirat");
  char buf[PATH_MAX];
  return real(dirfd, redirect(path, buf), mode);
}

/* ---- opendir / fopen (insurance) ---------------------------------------- */

DIR *opendir(const char *path) {
  static DIR *(*real)(const char *);
  if (!real)
    real = (DIR *(*)(const char *))dlsym(RTLD_NEXT, "opendir");
  char buf[PATH_MAX];
  return real(redirect(path, buf));
}

FILE *fopen(const char *path, const char *mode) {
  static FILE *(*real)(const char *, const char *);
  if (!real)
    real = (FILE *(*)(const char *, const char *))dlsym(RTLD_NEXT, "fopen");
  char buf[PATH_MAX];
  return real(redirect(path, buf), mode);
}

FILE *fopen64(const char *path, const char *mode) {
  static FILE *(*real)(const char *, const char *);
  if (!real)
    real = (FILE *(*)(const char *, const char *))dlsym(RTLD_NEXT, "fopen64");
  char buf[PATH_MAX];
  return real(redirect(path, buf), mode);
}
