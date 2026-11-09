# T3 Code reads PATH from a login shell, and Debian's /etc/profile resets PATH
# for non-root users. Put the user-level agent locations first again.
export PATH="$HOME/.local/bin:$HOME/.opencode/bin:$HOME/.bun/bin:/opt/synology/bin:/opt/t3:$PATH"
