# Terminal WebSocket protocol

```text
WS /api/sessions/:name/terminal?cols=<cols>&rows=<rows>
```

`cols` and `rows` are optional initial dimensions, clamped to the limits below. The types are defined
in [`packages/shared/src/types/terminal-protocol.ts`](../packages/shared/src/types/terminal-protocol.ts).

## Handshake

The upgrade is refused with HTTP 403 unless the `Host` header and a **mandatory** `Origin` header
both match `ECC_ALLOWED_ORIGINS`. Every other failure happens after the upgrade, as an `error`
message followed by a close code, because browsers cannot read the status of a failed upgrade.

## Frames

Binary frames are sent only by the server, and contain raw terminal output. A frame may end in the
middle of a UTF-8 sequence, so feed them to a streaming decoder (`xterm.write(Uint8Array)` is one).

Text frames contain JSON.

### Client to server

| Message | Limits | Effect |
| --- | --- | --- |
| `{"type":"input","data":string}` | 64 KiB (UTF-16 code units) per message, 4 MiB per second | Written to the PTY. Split larger pastes into several messages. |
| `{"type":"resize","cols":int,"rows":int}` | cols 2-1000, rows 2-500 | Resizes the PTY. |
| `{"type":"scroll","lines":int}` | -100 to 100, not 0 | Scrolls tmux history, or passes the wheel to a full-screen application in the pane. Negative is up. |

An invalid message gets a `PROTOCOL_ERROR` reply and is otherwise ignored. A frame above the size
limit closes the connection with code 1009. Input sent before `ready` is discarded.

### Server to client

| Message | Meaning |
| --- | --- |
| `{"type":"ready","session":string,"cols":int,"rows":int}` | The PTY is attached. tmux will now repaint the screen, so clear the terminal. |
| `{"type":"exit","reason":"session-ended"\|"detached","message":string}` | The tmux client exited. A close follows. |
| `{"type":"error","code":string,"message":string}` | See the codes below. A close follows, except for `PROTOCOL_ERROR`. |

## Close codes

| Code | Error or reason | Should the client reconnect? |
| --- | --- | --- |
| 4001 | Detached, for example with the tmux prefix and `d` | On user request |
| 4400 | `INVALID_SESSION_NAME` | No |
| 4404 | `SESSION_NOT_FOUND` | No |
| 4409 | `SESSION_BUSY`: another client holds the one interactive attachment | On user request |
| 4410 | Session ended, killed, or its last shell exited | No |
| 4413 | `INPUT_LIMIT_EXCEEDED` | On user request |
| 4500 | `ATTACH_FAILED` | On user request |
| 1001 | Backend shutting down | Automatically, with backoff |
| 1006 and others | Connection lost | Automatically, with backoff |

## Lifetime and flow control

- Closing the socket kills only the `tmux attach-session` client in the PTY. The tmux session lives on.
- The server pings every 15 seconds. A client that misses a pong by the next ping is dropped, which
  frees the session's attachment after a network failure with no close frame.
- When more than 1 MiB of output is unsent, the server stops reading from the PTY until it falls to
  256 KiB. tmux absorbs this: applications keep running and the client gets repainted when it catches up.
