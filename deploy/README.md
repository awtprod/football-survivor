# Dedicated Tailscale Service for the PWA

## Why this exists

The PWA used to be exposed with `tailscale serve` on this node's own hostname
(`openclaw-server.tailbd9828.ts.net`). That serve config is **global to the
node and last-writer-wins**, so when another agent ran `tailscale serve` to
publish its report, it overwrote the PWA's endpoint.

The fix is to give the PWA its own **Tailscale Service** (`svc:football-survivor`).
A Service is a separate, named endpoint with:

- its own hostname — `football-survivor.tailbd9828.ts.net`
- its own auto-provisioned TLS cert (needed for the service worker + web-push)
- its own config, namespaced under `svc:` — **untouched** by any plain
  `tailscale serve` on the node root.

So the report and the PWA can coexist, and the PWA can't be clobbered again.

```
                          openclaw-server (host)
  https://openclaw-server.tailbd9828.ts.net      -> node-root serve (the report; not ours)
  https://football-survivor.tailbd9828.ts.net     -> svc:football-survivor -> 127.0.0.1:3910 (PWA)
```

## What gets installed

Three systemd **user** units (rendered from the templates here by `setup.sh`):

| Unit | Role |
|------|------|
| `football-survivor.service` | Runs `node server.js` on `127.0.0.1:3910`. |
| `football-survivor-tailscale.service` | Asserts `svc:football-survivor` -> `--https=443` -> local app. |
| `football-survivor-tailscale.timer` | Re-asserts every 5 min (self-heals if ever cleared). |

## One-time prerequisites

1. **Tag the host.** Services require a tag-based identity. If `openclaw-server`
   isn't tagged, own `tag:server` in your policy file
   (see `policy-grant.hujson`) and apply it:
   ```
   sudo tailscale up --advertise-tags=tag:server
   ```
2. **Let this user drive `tailscale serve`:**
   ```
   sudo tailscale set --operator=$USER
   ```
3. **Enable systemd user lingering** so the units run without an active login:
   ```
   sudo loginctl enable-linger "$USER"
   ```

## Install

```
cd /path/to/football-survivor
npm install
deploy/setup.sh          # renders + installs + enables the three units
```

`setup.sh` auto-detects the tailnet name from `tailscale status`; override with
`TAILNET=your-tailnet.ts.net deploy/setup.sh` if needed. Re-run it any time
(after a `git pull`, or to re-apply the serve config) — it's idempotent.

## Approve + grant access

After the first run, the node is advertising the service but it needs approval:

1. In the [admin console](https://login.tailscale.com/admin/services), **approve**
   `svc:football-survivor`.
2. Merge the grant in [`policy-grant.hujson`](./policy-grant.hujson) into your
   tailnet policy file so you (or the tailnet) can reach it.

Then open **https://football-survivor.tailbd9828.ts.net**. On iPhone: Safari →
Share → Add to Home Screen → open from the icon → Settings → Enable push.

> **New origin:** the PWA moved off the node root, so this is a fresh origin.
> Re-add it to the Home Screen once and re-enable push there; the old install
> and its push subscription pointed at the node-root origin.

## Verify

```
# Dedicated service config (this is what you care about):
tailscale serve --service=svc:football-survivor status

# Node-root serve config (the report) — untouched by any of the above:
tailscale serve status

systemctl --user status football-survivor.service \
  football-survivor-tailscale.service football-survivor-tailscale.timer
```

## Uninstall

```
deploy/uninstall.sh      # stops the units and clears ONLY svc:football-survivor
```
This never touches the node-root serve config. Delete the service definition in
the admin console if you want it fully gone.

## Troubleshooting

- **`tailscale serve` says "access denied" / operator error** — run the
  `tailscale set --operator=$USER` step, or run the serve command with `sudo`.
- **Service never becomes reachable** — it's advertised but not yet approved;
  approve it in the admin console, and confirm the grant in your policy file.
- **"must use a tag-based identity"** — the host is logged in as a user, not a
  tag. Re-auth with `--advertise-tags=tag:server` (step 1).
- **502 / connection refused at the service hostname** — the app unit isn't up.
  Check `systemctl --user status football-survivor.service` and that it's
  listening on `127.0.0.1:3910`.
