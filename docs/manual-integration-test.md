# Manual integration test

This proves the central promise with a real browser and real tmux: processes outlive the browser and
the backend. It uses a private tmux server (`-L ecc-manual`), so your own sessions are not involved.

## Setup

```bash
pnpm install && pnpm build
mkdir -p /tmp/ecc-manual/project
ECC_TMUX_SOCKET=ecc-manual ECC_PROJECT_ROOTS=/tmp/ecc-manual pnpm start
```

To test against a remote host, first run `ssh -N -L 3000:127.0.0.1:3000 you@host`.

## Steps

| # | Do | Expect |
| --- | --- | --- |
| 1 | Open <http://localhost:3000>, choose **New session**, name it `manual`, directory `/tmp/ecc-manual/project`, **Create**. | `manual` appears and is selected. The status shows **Connected** and a shell prompt appears. |
| 2 | In the terminal, run: `i=0; while true; do i=$((i+1)); echo "tick $i pid $$"; sleep 1; done` | Numbers count up. Note the pid. |
| 3 | Close the browser entirely. In another shell, run `tmux -L ecc-manual list-clients` | No clients are listed. |
| 4 | Run `tmux -L ecc-manual capture-pane -p -t '=manual:' \| tail -2`, wait a few seconds, and run it again. | The count keeps rising, with the same pid. |
| 5 | Stop the backend with Ctrl+C (or `sudo systemctl restart engineering-control-center`), and start it again. Repeat step 4's command. | The count keeps rising, with the same pid. |
| 6 | Reopen <http://localhost:3000>. | `manual` is listed, though the backend stored nothing. |
| 7 | Select `manual`. | The terminal reattaches and shows the same loop still counting, with the same pid. Nothing restarted. |
| 8 | Press Ctrl+C in the terminal, then run `echo $$`. | Input works, and the shell has the same pid. |

## Additional checks

| Do | Expect |
| --- | --- |
| Open the same session in a second tab. | The second tab reports **In use elsewhere** and the first is unaffected. Close the first, and **Reconnect** works in the second. |
| With a terminal open, run `tmux -L ecc-manual kill-session -t '=manual'` elsewhere. | The status changes to **Session ended** and the session leaves the list. |
| Stop the backend while a terminal is open, then start it within about 30 seconds. | The status shows **Reconnecting**, and then the terminal reattaches by itself. |
| Choose **Terminate**. | A warning naming Claude Code is shown. **Cancel** changes nothing. **Terminate session** kills it. |
| Resize the browser window, and run `stty size`. | The dimensions follow the window. |
| Scroll with the wheel after `seq 1 500`. Then type a key. | History scrolls, with a position indicator in the corner. Typing returns to the prompt. |
| Run `vim` or `htop`, and `printf '\e[38;2;255;100;0mtruecolor\e[0m\n'`. | Full-screen programs and 24-bit color render correctly. |
| Run `claude`, get a long reply, and scroll up with the wheel. | The transcript scrolls. Previous prompts are not recalled into the input box. |
| Run `claude`. | Claude Code's interface works. Close the browser and reopen it: the conversation is still there. |

## Cleanup

```bash
tmux -L ecc-manual kill-server
rm -rf /tmp/ecc-manual
```
