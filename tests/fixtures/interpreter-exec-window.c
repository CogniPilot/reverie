#define _GNU_SOURCE
#include <errno.h>
#include <signal.h>
#include <sys/prctl.h>
#include <time.h>
#include <unistd.h>
#ifndef REAL_PYTHON
#error REAL_PYTHON required
#endif
int main(int argc, char **argv, char **envp) {
    (void)argc;
    if (prctl(PR_SET_DUMPABLE, 0, 0, 0, 0) < 0) return 91;
    if (raise(SIGSTOP) != 0) return 92;
    struct timespec delay = { .tv_sec = 0, .tv_nsec = 250000000L };
    while (nanosleep(&delay, &delay) < 0) if (errno != EINTR) return 93;
    execve(REAL_PYTHON, argv, envp);
    return 94;
}
