/* Fixed image-root H monitor. Build statically; never execute from writable /nix.
 * No command/argv/path/environment selector. PTY text is only O frames. A/X
 * control frames originate here, with a host nonce absent from the user shell.
 * Parent exit is not settlement: subreaper ECHILD + empty descendant inventory
 * are required. An unknown outcome deliberately produces no positive receipt.
 */
#define _GNU_SOURCE
#include <arpa/inet.h>
#include <ctype.h>
#include <dirent.h>
#include <errno.h>
#include <endian.h>
#include <fcntl.h>
#include <limits.h>
#include <poll.h>
#include <signal.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/ioctl.h>
#include <sys/prctl.h>
#include <sys/resource.h>
#include <sys/stat.h>
#include <sys/syscall.h>
#include <sys/types.h>
#include <sys/wait.h>
#include <termios.h>
#include <time.h>
#include <unistd.h>

#ifndef HUMAN_SHELL
#define HUMAN_SHELL "/opt/reverie/human/bin/bash"
#endif
#ifndef HUMAN_HOME
#define HUMAN_HOME "/home/agent"
#endif
#define MAX_ROWS 32768
#define MAX_CHILDREN 1024
#define MAX_FRAME 4096
#define MAX_TOTAL (16U * 1024U * 1024U)
#define MAX_QUEUE 65536
struct process { pid_t pid, parent; unsigned long long start; int selected; };
static struct process rows[MAX_ROWS];
static volatile sig_atomic_t stopped;
static void stopping(int number) { (void)number; stopped = 1; }
static double now(void) {
    struct timespec value;
    if (clock_gettime(CLOCK_MONOTONIC, &value)) _exit(125);
    return (double)value.tv_sec + (double)value.tv_nsec / 1e9;
}
static uint64_t wall_ms(void) {
    struct timespec value;
    if (clock_gettime(CLOCK_REALTIME, &value) || value.tv_sec < 0) _exit(125);
    return (uint64_t)value.tv_sec * 1000U + (uint64_t)value.tv_nsec / 1000000U;
}
static int nonblocking(int fd) {
    int flags = fcntl(fd, F_GETFL);
    return flags < 0 ? -1 : fcntl(fd, F_SETFL, flags | O_NONBLOCK);
}
static int process(pid_t pid, struct process *value) {
    char path[64], text[8193];
    int length = snprintf(path, sizeof(path), "/proc/%ld/stat", (long)pid);
    if (length < 0 || (size_t)length >= sizeof(path)) return -1;
    int fd = open(path, O_RDONLY | O_NOFOLLOW | O_CLOEXEC | O_NONBLOCK);
    if (fd < 0) return errno == ENOENT || errno == ESRCH ? 0 : -1;
    ssize_t count = read(fd, text, sizeof(text) - 1);
    int saved = errno; close(fd); errno = saved;
    if (count <= 0 || count >= (ssize_t)sizeof(text) - 1) return -1;
    text[count] = 0;
    char *tail = strrchr(text, ')');
    if (!tail || tail[1] != ' ') return -1;
    char *cursor = NULL, *token = strtok_r(tail + 2, " ", &cursor);
    long parent = -1; unsigned long long start = 0;
    for (int field = 0; field <= 19; field++, token = strtok_r(NULL, " ", &cursor)) {
        if (!token) return -1;
        if (field == 1 || field == 19) {
            char *end;
            errno = 0;
            unsigned long long parsed = strtoull(token, &end, 10);
            if (errno || *end || (field == 1 && parsed > INT_MAX)) return -1;
            if (field == 1) parent = (long)parsed;
            else start = parsed;
        }
    }
    value->pid = pid; value->parent = (pid_t)parent; value->start = start; value->selected = 0;
    return 1;
}
static int by_pid(const void *a, const void *b) {
    pid_t left = ((const struct process *)a)->pid, right = ((const struct process *)b)->pid;
    return left < right ? -1 : left != right;
}
static int inventory(void) {
    DIR *directory = opendir("/proc");
    if (!directory) return -1;
    int count = 0, failed = 0;
    struct dirent *entry;
    for (;;) {
        errno = 0; entry = readdir(directory);
        if (!entry) { if (errno) failed = 1; break; }
        if (!isdigit((unsigned char)entry->d_name[0])) continue;
        char *end; errno = 0;
        long pid = strtol(entry->d_name, &end, 10);
        if (errno || *end || pid <= 0 || pid > INT_MAX) { failed = 1; break; }
        if (count >= MAX_ROWS) { failed = 1; break; }
        int result = process((pid_t)pid, &rows[count]);
        if (result < 0) { failed = 1; break; }
        if (result) count++;
    }
    closedir(directory);
    if (failed) return -1;
    qsort(rows, (size_t)count, sizeof(rows[0]), by_pid);
    pid_t self = getpid();
    for (int depth = 0; depth < 64; depth++) {
        int changed = 0, selected = 0;
        for (int i = 0; i < count; i++) {
            if (rows[i].pid == self) continue;
            int include = rows[i].parent == self;
            if (!include) {
                struct process key = {.pid = rows[i].parent};
                struct process *parent = bsearch(&key, rows, (size_t)count, sizeof(rows[0]), by_pid);
                include = parent && parent->selected;
            }
            if (include && !rows[i].selected) { rows[i].selected = 1; changed = 1; }
            selected += rows[i].selected;
        }
        if (selected > MAX_CHILDREN) return -1;
        if (!changed) return count;
    }
    return -1;
}
static int reap(void) {
    int status;
    pid_t result;
    do { result = waitpid(-1, &status, WNOHANG); } while (result > 0);
    return result < 0 && errno == ECHILD;
}
static int empty_tree(void) {
    int no_children = reap();
    int count = inventory();
    if (count < 0) return -1;
    for (int i = 0; i < count; i++) if (rows[i].selected) return 0;
    return no_children ? 1 : 0;
}
static int cleanup(int master) {
    close(master);
    const int signals[] = {SIGHUP, SIGTERM, SIGKILL};
    const double grace[] = {.25, .25, 2.0};
    for (int round = 0; round < 3; round++) {
        reap();
        int count = inventory();
        if (count < 0) return 0;
        for (int i = 0; i < count; i++) {
            if (!rows[i].selected) continue;
            int fd = (int)syscall(SYS_pidfd_open, rows[i].pid, 0);
            if (fd < 0) { if (errno == ESRCH) continue; return 0; }
            struct process current;
            int known = process(rows[i].pid, &current);
            if (known == 1 && current.start == rows[i].start) {
                if (syscall(SYS_pidfd_send_signal, fd, signals[round], NULL, 0) < 0 && errno != ESRCH) {
                    close(fd); return 0;
                }
            } else if (known < 0) { close(fd); return 0; }
            close(fd);
        }
        double end = now() + grace[round];
        while (now() < end) {
            int empty = empty_tree();
            if (empty != 0) return empty == 1;
            struct timespec delay = {0, 10000000}; nanosleep(&delay, NULL);
        }
    }
    return empty_tree() == 1;
}
static int append(unsigned char *queue, size_t *used, char kind, const void *data, size_t size) {
    if (size > MAX_FRAME || *used + size + 5 > MAX_QUEUE) return -1;
    queue[*used] = (unsigned char)kind;
    uint32_t length = htonl((uint32_t)size);
    memcpy(queue + *used + 1, &length, 4);
    memcpy(queue + *used + 5, data, size); *used += size + 5; return 0;
}
static int flush(unsigned char *queue, size_t *used) {
    ssize_t count = write(STDOUT_FILENO, queue, *used);
    if (count < 0) return errno == EINTR || errno == EAGAIN ? 0 : -1;
    memmove(queue, queue + count, *used - (size_t)count); *used -= (size_t)count; return 0;
}
static int initial_until(unsigned char *bytes, size_t length, double end) {
    size_t used = 0;
    while (used < length && !stopped) {
        double remaining = end - now(); if (remaining <= 0) return -1;
        struct pollfd fd = {STDIN_FILENO, POLLIN, 0};
        int ready = poll(&fd, 1, (int)(remaining * 1000));
        if (ready < 0 && errno == EINTR) continue;
        if (ready <= 0) return -1;
        ssize_t count = read(0, bytes + used, length - used);
        if (count <= 0) return -1;
        used += (size_t)count;
    }
    return used == length ? 0 : -1;
}
static void child_fail(int fd, int code) {
    int value = code;
    ssize_t sent = write(fd, &value, sizeof(value));
    _exit(sent == (ssize_t)sizeof(value) ? 126 : 127);
}
int main(int argc, char **argv) {
    (void)argv;
    if (argc != 1) return 125;
    struct sigaction action = {0}; sigemptyset(&action.sa_mask); action.sa_handler = stopping;
    if (sigaction(SIGHUP, &action, NULL) || sigaction(SIGINT, &action, NULL) || sigaction(SIGTERM, &action, NULL)) return 125;
    action.sa_handler = SIG_IGN; if (sigaction(SIGPIPE, &action, NULL)) return 125;
    action.sa_handler = SIG_DFL; if (sigaction(SIGCHLD, &action, NULL)) return 125;
    if (prctl(PR_SET_CHILD_SUBREAPER, 1, 0, 0, 0) || prctl(PR_SET_DUMPABLE, 0, 0, 0, 0)) return 125;
    if (syscall(SYS_close_range, 3U, UINT_MAX, 0) < 0) return 125;
    int self_fd = (int)syscall(SYS_pidfd_open, getpid(), 0);
    if (self_fd < 0) return 125;
    int usable = (int)syscall(SYS_pidfd_send_signal, self_fd, 0, NULL, 0);
    close(self_fd);
    if (usable < 0) return 125; /* unsupported seccomp/kernel: before any child */
    unsigned char init[78];
    if (initial_until(init, sizeof(init), now() + 5) || init[0] != 'H' || init[1] != '1') return 125;
    char nonce[65]; memcpy(nonce, init + 2, 64); nonce[64] = 0;
    for (int i = 0; i < 64; i++) if (!strchr("0123456789abcdef", nonce[i])) return 125;
    uint64_t expires; uint16_t cols, height;
    memcpy(&expires, init + 66, 8); expires = be64toh(expires);
    memcpy(&cols, init + 74, 2); cols = ntohs(cols);
    memcpy(&height, init + 76, 2); height = ntohs(height);
    uint64_t current_wall = wall_ms();
    if (expires <= current_wall || expires - current_wall > 3600000U || cols < 2 || cols > 300 || height < 2 || height > 120) return 125;
    double expiry = now() + (double)(expires - current_wall) / 1000.0;
    struct process self;
    if (process(getpid(), &self) != 1 || prctl(PR_GET_DUMPABLE, 0, 0, 0, 0) != 0) return 125;
    char prepared[256];
    int prepared_size = snprintf(prepared, sizeof(prepared), "{\"nonce\":\"%s\",\"monitorPid\":%ld,\"monitorStart\":%llu}",
                                 nonce, (long)getpid(), self.start);
    unsigned char prepared_frame[512]; size_t prepared_used = 0;
    if (prepared_size <= 0 || (size_t)prepared_size >= sizeof(prepared)
        || append(prepared_frame, &prepared_used, 'P', prepared, (size_t)prepared_size) || nonblocking(1)) return 125;
    double grant_deadline = now() + 5;
    if (grant_deadline > expiry) grant_deadline = expiry;
    while (prepared_used && !stopped && now() < grant_deadline) {
        struct pollfd fd = {1, POLLOUT, 0};
        if (poll(&fd, 1, 50) > 0 && flush(prepared_frame, &prepared_used)) return 125;
    }
    unsigned char grant[69];
    if (prepared_used || initial_until(grant, sizeof(grant), grant_deadline) || grant[0] != 'G') return 125;
    uint32_t grant_size; memcpy(&grant_size, grant + 1, 4);
    if (ntohl(grant_size) != 64 || memcmp(grant + 5, nonce, 64)
        || stopped || now() >= expiry || wall_ms() >= expires) return 125;
    int master = posix_openpt(O_RDWR | O_NOCTTY | O_CLOEXEC);
    if (master < 0) return 125;
    char name[128];
    if (grantpt(master) || unlockpt(master) || ptsname_r(master, name, sizeof(name))) { close(master); return 125; }
    int slave = open(name, O_RDWR | O_NOCTTY | O_CLOEXEC);
    struct winsize dimensions = {height, cols, 0, 0};
    if (slave < 0 || ioctl(slave, TIOCSWINSZ, &dimensions)) { if (slave >= 0) close(slave); close(master); return 125; }
    int error_pipe[2];
    if (pipe2(error_pipe, O_CLOEXEC | O_NONBLOCK)) { close(slave); close(master); return 125; }
    sigset_t mask, previous;
    sigemptyset(&mask); sigaddset(&mask, SIGHUP); sigaddset(&mask, SIGINT); sigaddset(&mask, SIGTERM);
    if (sigprocmask(SIG_BLOCK, &mask, &previous)) { close(slave); close(master); close(error_pipe[0]); close(error_pipe[1]); return 125; }
    pid_t child = fork();
    if (child == 0) {
        close(error_pipe[0]);
        if (setsid() < 0 || ioctl(slave, TIOCSCTTY, 0)) child_fail(error_pipe[1], 1);
        for (int fd = 0; fd < 3; fd++) if (dup2(slave, fd) < 0) child_fail(error_pipe[1], 2);
        if (error_pipe[1] != 3 && dup3(error_pipe[1], 3, O_CLOEXEC) < 0) child_fail(error_pipe[1], 3);
        if (syscall(SYS_close_range, 4U, UINT_MAX, 0) < 0) child_fail(3, 4);
        struct sigaction defaults = {0}; defaults.sa_handler = SIG_DFL; sigemptyset(&defaults.sa_mask);
        for (int number = 1; number < NSIG; number++) if (number != SIGKILL && number != SIGSTOP) (void)sigaction(number, &defaults, NULL);
        if (sigprocmask(SIG_SETMASK, &previous, NULL) || chdir(HUMAN_HOME)) child_fail(3, 5);
        char *const shell[] = {HUMAN_SHELL, "--noprofile", "--norc", "-i", NULL};
        char *const environment[] = {"HOME=" HUMAN_HOME, "PATH=/bin:/usr/bin", "TERM=xterm-256color", "COLORTERM=truecolor",
            "XDG_CONFIG_HOME=" HUMAN_HOME "/.human/config", "XDG_DATA_HOME=" HUMAN_HOME "/.human/data", "XDG_CACHE_HOME=" HUMAN_HOME "/.human/cache", NULL};
        execve(HUMAN_SHELL, shell, environment); child_fail(3, 6);
    }
    close(slave); close(error_pipe[1]);
    if (sigprocmask(SIG_SETMASK, &previous, NULL)) stopped = 1;
    if (child < 0) { close(master); close(error_pipe[0]); return 125; }
    const char *failure = NULL;
    unsigned char output[MAX_QUEUE], input[MAX_FRAME * 2 + 10]; size_t output_used = 0, input_used = 0;
    unsigned long received = 0, sent = 0;
    struct process first;
    if (process(child, &first) != 1) failure = "ChildIdentity";
    struct pollfd execfd = {error_pipe[0], POLLIN | POLLHUP, 0};
    int ready = poll(&execfd, 1, 2000), exec_error = 0;
    ssize_t exec_count = ready > 0 ? read(error_pipe[0], &exec_error, sizeof(exec_error)) : -1;
    close(error_pipe[0]);
    if (ready <= 0 || exec_count != 0) failure = "ChildExec";
    if (nonblocking(master) || nonblocking(1)) failure = "Descriptor";
    char result[512];
    if (!failure && !stopped) {
        if (prctl(PR_GET_DUMPABLE, 0, 0, 0, 0) != 0) failure = "PrivateMonitor";
    }
    if (!failure && !stopped) {
        int size = snprintf(result, sizeof(result), "{\"nonce\":\"%s\",\"monitorPid\":%ld,\"monitorStart\":%llu,\"childPid\":%ld,\"childStart\":%llu}",
                            nonce, (long)getpid(), self.start, (long)child, first.start);
        if (size <= 0 || (size_t)size >= sizeof(result) || append(output, &output_used, 'A', result, (size_t)size)) failure = "Ready";
    }
    double idle = now();
    while (!failure && !stopped && now() < expiry && wall_ms() < expires && now() - idle < 900) {
        struct pollfd fds[] = {{0, POLLIN, 0}, {master, POLLIN, 0}, {1, output_used ? POLLOUT : 0, 0}};
        int selected = poll(fds, 3, 100);
        if (selected < 0) { if (errno == EINTR) continue; failure = "Poll"; break; }
        if (fds[2].revents & (POLLERR | POLLHUP)) { failure = "OutputClosed"; break; }
        if (fds[2].revents & POLLOUT) if (flush(output, &output_used)) { failure = "OutputClosed"; break; }
        if (fds[1].revents & (POLLIN | POLLHUP)) {
            unsigned char bytes[MAX_FRAME]; ssize_t count = read(master, bytes, sizeof(bytes));
            if (!count || (count < 0 && errno == EIO)) break;
            if (count < 0) { if (errno != EAGAIN && errno != EINTR) failure = "PtyRead"; }
            else {
                sent += (unsigned long)count;
                if (sent > MAX_TOTAL || append(output, &output_used, 'O', bytes, (size_t)count)) { failure = "OutputBound"; break; }
            }
        }
        if (fds[0].revents & (POLLIN | POLLHUP)) {
            ssize_t count = read(0, input + input_used, sizeof(input) - input_used);
            if (!count) break;
            if (count < 0) { if (errno == EINTR) continue; failure = "InputRead"; break; }
            input_used += (size_t)count;
            while (input_used >= 5) {
                uint32_t size; memcpy(&size, input + 1, 4); size = ntohl(size);
                if (size > MAX_FRAME) { failure = "InputBound"; break; }
                if (input_used < size + 5) break;
                unsigned char kind = input[0]; unsigned char *data = input + 5;
                if (kind == 'Q' && size == 0) stopped = 1;
                else if (kind == 'I') {
                    received += size;
                    if (received > MAX_TOTAL || write(master, data, size) != (ssize_t)size) failure = "InputUnconfirmed";
                } else if (kind == 'R' && size == 4) {
                    uint16_t x, y; memcpy(&x, data, 2); memcpy(&y, data + 2, 2); x = ntohs(x); y = ntohs(y);
                    struct winsize next = {y, x, 0, 0};
                    if (x < 2 || x > 300 || y < 2 || y > 120 || ioctl(master, TIOCSWINSZ, &next)) failure = "Resize";
                } else failure = "FrameKind";
                memmove(input, input + size + 5, input_used - size - 5); input_used -= size + 5;
                idle = now(); if (failure || stopped) break;
            }
        }
    }
    int settled = cleanup(master);
    int size = snprintf(result, sizeof(result), "{\"nonce\":\"%s\",\"settled\":%s,\"failureClass\":%s%s%s}",
                        nonce, settled ? "true" : "false", failure ? "\"" : "", failure ? failure : "null", failure ? "\"" : "");
    int receipt = size > 0 && (size_t)size < sizeof(result) && !append(output, &output_used, 'X', result, (size_t)size);
    double drain = now() + 1;
    while (receipt && output_used && now() < drain) {
        struct pollfd fd = {1, POLLOUT, 0};
        if (poll(&fd, 1, 50) > 0 && flush(output, &output_used)) break;
    }
    return settled && !failure && receipt && !output_used ? 0 : 124;
}
