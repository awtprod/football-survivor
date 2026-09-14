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
  https://openclaw-server.tailbd9828.ts.net        -> node-root serve (the report; not ours)
  https://openclaw-server.tailbd9828.ts.net:8443   -> Funnel -> 127.0.0.1:3910 (PWA, PUBLIC)
  https://football-survivor.tailbd9828.ts.net       -> svc:football-survivor -> 127.0.0.1:3910 (PWA, tailnet-only)
```

## Two ways in: tailnet-only Service vs. public Funnel
- **Tailnet-only** (`football-survivor.<tailnet>`): the dedicated Service. Fully
  isolated — a plain `tailscale serve` on the node root can't overwrite it.
  Reachable only from devices on your tailnet.
- **Public** (`openclaw-server.<tailnet>:8443`): Tailscale **Funnel**, for
  devices *not* on your tailnet. Funnel only works on the **node hostname** and
  only on ports **443/8443/10000** — it can't use a `svc:`, so it can't have the
  pretty hostname. It lives in the node's own serve config (shared with the root,
  e.g. a report on :443), so it can be overwritten; the `.timer` re-asserts it
  every 5 min. Requires the `funnel` nodeAttr on `tag:server` (see
  `policy-grant.hujson`) — a tagged node doesn't inherit the default
  `autogroup:member` grant. **This puts the app on the public internet** (it is
  auth-gated by Google sign-in, but the login page is reachable by anyone).

## What gets installed

Three systemd **user** units (rendered from the templates here by `setup.sh`):

| Unit | Role |
|------|------|
| `football-survivor.service` | Runs `node server.js` on `127.0.0.1:3910`. |
| `football-survivor-tailscale.service` | Asserts `svc:football-survivor` (tailnet) **and** Funnel on `:8443` (public) -> local app. |
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
# Dedicated service config (tailnet-only):
tailscale serve --service=svc:football-survivor status

# Full serve/funnel config incl. the :8443 Funnel and the node root (the report):
tailscale serve status
tailscale funnel status

# Public reachability (run anywhere, even off-tailnet):
curl -sS -o /dev/null -w "HTTP %{http_code}\n" https://openclaw-server.tailbd9828.ts.net:8443

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
- **`service hosts must be tagged nodes`** (the tailscale unit fails to start) —
  the host isn't tagged. Fix, in order: (1) add `tag:server` to `tagOwners` and
  the grants in `policy-grant.hujson`, including a grant that keeps your own
  access to `tag:server` so you don't lock yourself out; (2) on the host run
  `sudo tailscale set --advertise-tags=tag:server` (or
  `sudo tailscale up --advertise-tags=tag:server`); (3)
  `systemctl --user restart football-survivor-tailscale.service`; (4) approve
  the service in the admin console.
- **"must use a tag-based identity"** — same cause as above; the host is logged
  in as a user, not a tag.
- **502 / connection refused at the service hostname** — the app unit isn't up.
  Check `systemctl --user status football-survivor.service` and that it's
  listening on `127.0.0.1:3910`.
