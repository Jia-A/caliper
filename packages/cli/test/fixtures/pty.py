# Runs a command in a pseudo-terminal, so it sees an interactive terminal (stdin and stdout
# are TTYs), and relays this process's stdin to it and its output to this process's stdout.
# Node can't open a pty without a native module, and macOS `script` needs a real terminal on
# its own stdin. Usage: python3 -I pty.py <command> [args...]; exits with the command's code.
import os
import pty
import select
import sys

pid, fd = pty.fork()
if pid == 0:
    os.execvp(sys.argv[1], sys.argv[1:])

stdin_open = True
while True:
    ready, _, _ = select.select([fd] + ([0] if stdin_open else []), [], [])
    if fd in ready:
        try:
            data = os.read(fd, 65536)
        except OSError:  # the command exited and closed the terminal
            break
        if not data:
            break
        os.write(1, data)
    if 0 in ready:
        data = os.read(0, 65536)
        if data:
            os.write(fd, data)
        else:
            stdin_open = False

_, status = os.waitpid(pid, 0)
sys.exit(os.waitstatus_to_exitcode(status))
