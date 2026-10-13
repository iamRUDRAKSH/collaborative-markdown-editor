# Deployment

Two pieces deploy separately:

| Piece | What it needs | Service type on Render |
| ----- | ------------- | ---------------------- |
| Frontend | Static file hosting + SPA rewrites | Static Site |
| Signaling relay | Long-lived **WebSocket** connections | Web Service (Node) |

The document itself is never hosted anywhere. It lives in the browsers; the relay only
carries SDP offers, answers and ICE candidates, and can be switched off once peers are
connected.

## Order matters

`VITE_SIGNALING_URL` is inlined by Vite at **build time**, not read at runtime. So:

1. Deploy the signaling relay first.
2. Set `VITE_SIGNALING_URL` on the frontend to its address.
3. Rebuild the frontend.

Changing the signaling URL later means a **rebuild and redeploy**, not a restart.

## Fastest path: the Blueprint

`render.yaml` at the repo root declares both services.

1. Render dashboard → **New** → **Blueprint**.
2. Pick this repository. Render reads `render.yaml` and creates `ds-signaling` and
   `ds-editor`.
3. Wait for `ds-signaling` to go live and copy its URL
   (`https://ds-signaling-xxxx.onrender.com`).
4. Open `ds-editor` → **Environment** → set:
   ```
   VITE_SIGNALING_URL = wss://ds-signaling-xxxx.onrender.com
   ```
   Note **`wss://`**, not `https://` and not `ws://`.
5. Trigger a manual deploy of `ds-editor` so the new value is baked in.

If Render rejects `runtime: static`, your account is on the older Blueprint schema — change
that key to `env: static` and re-sync. Everything else is identical.

## Manual path, if you would rather click

**Signaling service** — New → Web Service → this repo:

* Runtime: Node
* Build command: `npm install`
* Start command: `npm run signaling`
* Health check path: `/`
* Plan: Free

Do not set `PORT` yourself. Render injects it, and the server reads `process.env.PORT`.

**Frontend** — New → Static Site → same repo:

* Build command: `npm install && npm run build`
* Publish directory: `dist`
* Environment: `VITE_SIGNALING_URL = wss://<your-signaling>.onrender.com`
* Redirects/Rewrites: source `/*`, destination `/index.html`, type **Rewrite**

That rewrite is not optional. Without it, opening `/room/abc` directly returns 404 and only
the home page works.

## Verify before assuming it works

```bash
curl -i https://<your-signaling>.onrender.com/
```

You want `HTTP/2 200` and the body `okay`. That is the signaling server answering.

If you get `404` with a header `x-render-routing: no-server`, there is **no service attached
to that hostname** — it was deleted, suspended, or you have the wrong URL. This is exactly
what happened to the previous deployment of this project, and it is not a cold start: a
sleeping instance takes 30-60 seconds, a missing one answers instantly.

Then, end to end:

1. Open the deployed frontend in **two different browsers**, same room, different names.
2. Type in one; it should appear in the other.
3. Open the inspector. "Live peers" should be 1 and a coordinator elected within a couple of
   seconds.
4. If the document syncs but the inspector shows 0 peers, the Yjs mesh connected and the
   coordination mesh did not — check the signaling URL actually in the bundle.

## The free-tier cold start, and what to do about it

Render free instances spin down after about 15 minutes of inactivity. The first connection
afterwards does **not** wait politely:

* The WebSocket connect fails outright while the instance boots.
* `y-webrtc` and our own mesh both retry with backoff, so it recovers on its own after
  roughly 30-60 seconds.
* To the user it looks like the room is simply empty, with no explanation. The UI has no
  indicator for this, which is a genuine failure-transparency gap rather than a bug.

**Before a live demo**, open the signaling URL in a browser tab a minute beforehand to wake
it. That one step avoids the most likely way the demonstration embarrasses you.

If you want to avoid the cold start entirely, `deploy/cloudflare/` holds a Worker +
Durable Object implementation of the same protocol with no spin-down. It is also the
Unit IV serverless deliverable, so it is worth deploying even if Render stays primary.

## Optional — Docker instead of the Node runtime

`deploy/docker/Dockerfile` builds the signaling server as an image. On Render, choose
**Docker** as the runtime and point it at `deploy/docker/Dockerfile`. Slower to build, but
it is the same artefact that runs under Kubernetes, which makes the virtualization claim in
the report concrete rather than theoretical.

## Optional — TURN relay

Without TURN, ICE has only host and STUN candidates. Two peers on the same network connect
fine; a peer behind a symmetric NAT or a locked-down campus or corporate network cannot
connect at all, and the failure looks like "it just never syncs".

```
VITE_TURN_URL=turn:turn.example.com:3478
VITE_TURN_USERNAME=...
VITE_TURN_CREDENTIAL=...
```

All three are build-time variables, so adding them needs a redeploy.

## Optional — encrypted rooms

```
https://<your-app>.onrender.com/room/<id>#key=<secret>
```

The Yjs room is encrypted with a key derived from the secret. The fragment is never sent to
the server, so the relay routes the room without being able to read it.

## Known deployment limitations

* **The signaling relay is a single logical point for discovery.** Existing peers keep
  working without it; new peers cannot join. The UI gives no indication when this happens.
* **One Render instance only.** Scaling the relay horizontally would split the in-memory
  subscriber table across instances, so two peers could land on different ones and never
  discover each other. The same caveat is documented in `deploy/k8s/signaling.yaml`, and it
  is the argument for the Durable Object version.
* **Free tier has no persistent disk**, which does not matter here: signaling is discovery,
  not storage, and a peer that reconnects simply re-subscribes.
