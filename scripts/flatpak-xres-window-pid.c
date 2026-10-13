#include <sys/types.h>
#include <X11/Xlib.h>
#include <X11/Xatom.h>
#include <X11/extensions/XRes.h>
#include <errno.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/socket.h>
#include <sys/un.h>
#include <unistd.h>

/* Runner-only XRes 1.2 query. Never trust an application-supplied PID property. */
static int x_error;

static int trap_error(Display *display, XErrorEvent *event) {
    (void) display;
    x_error = event->error_code;
    return 0;
}

static int query_pid(Display *display, Window window, pid_t *pid, XID *client) {
    XWindowAttributes attributes;
    XResClientIdSpec spec = { window, XRES_CLIENT_ID_PID_MASK };
    XResClientIdValue *values = NULL;
    long count = 0;
    int status;
    x_error = 0;
    if (!XGetWindowAttributes(display, window, &attributes)) {
        XSync(display, False);
        return 0;
    }
    /* Unlike XResQueryVersion, this API returns Success (zero) on success. */
    status = XResQueryClientIds(display, 1, &spec, &count, &values);
    XSync(display, False);
    int valid = !x_error && status == Success && count == 1 && values
        && values[0].spec.mask == XRES_CLIENT_ID_PID_MASK
        && values[0].length == (long) sizeof(uint32_t) && values[0].value;
    if (valid) {
        *pid = XResGetClientPid(&values[0]);
        *client = values[0].spec.client;
        valid = *pid > 0 && *client != None;
    }
    /* XRes selects a client by ID range, so recheck the actual window still exists. */
    if (valid) valid = XGetWindowAttributes(display, window, &attributes) != 0;
    XSync(display, False);
    valid = valid && !x_error;
    if (values) XResClientIdsDestroy(count, values);
    return valid;
}

int main(int argc, char **argv) {
    int self_test = argc == 2 && strcmp(argv[1], "--self-test") == 0;
    Window window = None;
    if (!self_test) {
        char *end = NULL;
        if (argc != 2 || strspn(argv[1], "0123456789") != strlen(argv[1])) {
            fprintf(stderr, "Expected one decimal window resource ID or --self-test\n");
            return 2;
        }
        errno = 0;
        unsigned long value = strtoul(argv[1], &end, 10);
        if (errno || !end || *end || value == 0 || value > UINT32_MAX) {
            fprintf(stderr, "Invalid window resource ID\n");
            return 2;
        }
        window = (Window) value;
    }
    Display *display = XOpenDisplay(NULL);
    if (!display) { fprintf(stderr, "Cannot open disposable X display\n"); return 3; }
    XSetErrorHandler(trap_error);
    struct sockaddr_un address;
    socklen_t address_size = sizeof(address);
    int event_base, error_base, major = 0, minor = 0;
    if (getsockname(ConnectionNumber(display), (struct sockaddr *) &address, &address_size)
        || address.sun_family != AF_UNIX || !XResQueryExtension(display, &event_base, &error_base)
        || !XResQueryVersion(display, &major, &minor) || major != 1 || minor < 2) {
        fprintf(stderr, "Local Unix-socket XRes 1.2 server required\n");
        XCloseDisplay(display);
        return 4;
    }
    if (self_test) {
        window = XCreateSimpleWindow(display, DefaultRootWindow(display), 0, 0, 32, 32, 0, 0, 0);
        XMapWindow(display, window);
        XSync(display, False);
    }
    pid_t pid = -1;
    XID client = None;
    int valid = query_pid(display, window, &pid, &client);
    if (self_test && valid) {
        /* Missing and forged hints must not change the socket-credential PID. */
        valid = pid == getpid();
        unsigned long forged_pid = 1;
        Atom hint = XInternAtom(display, "_NET_WM_PID", False);
        XChangeProperty(display, window, hint, XA_CARDINAL, 32, PropModeReplace,
                        (unsigned char *) &forged_pid, 1);
        XSync(display, False);
        valid = valid && query_pid(display, window, &pid, &client) && pid == getpid();
        XDestroyWindow(display, window);
        XSync(display, False);
        pid_t dead_pid = -1;
        XID dead_client = None;
        valid = valid && !query_pid(display, window, &dead_pid, &dead_client);
    }
    if (valid) {
        printf("{\"window\":\"%lu\",\"pid\":%ld,\"client\":\"%lu\",\"xresMajor\":%d,\"xresMinor\":%d,\"selfTest\":%s}\n",
               window, (long) pid, client, major, minor, self_test ? "true" : "false");
    } else {
        fprintf(stderr, "No unique live local XRes PID for window %lu (X error %d)\n", window, x_error);
    }
    XCloseDisplay(display);
    return valid ? 0 : 5;
}
