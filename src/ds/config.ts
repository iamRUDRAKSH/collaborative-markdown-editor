/**
 * Deployment configuration shared by the Yjs replica and the coordination mesh.
 *
 * Both meshes use the same signaling relay but subscribe to different topics, so one
 * server serves document synchronisation and coordination discovery without either
 * knowing about the other.
 */

/** The deployed relay, used when the page is not served from a development host. */
const DEPLOYED_SIGNALING_URL = "wss://ds-signaling.onrender.com";

const LOCAL_SIGNALING_URL = "ws://localhost:4444";

/**
 * Where to reach the signaling relay.
 *
 * `VITE_SIGNALING_URL` still wins when it is set, so a different deployment can override
 * this without touching code. What changed is the fallback: it used to be localhost
 * unconditionally, which meant a production build that missed the environment variable
 * pointed every visitor at their own machine. The failure was silent -- the page loaded,
 * the editor worked, and every user simply sat alone in an empty room with no error. That
 * is a bad failure mode to depend on a dashboard setting for.
 *
 * Now the default is chosen from where the page is actually being served. A development
 * host gets the local relay; anything else gets the deployed one. A build with no
 * environment variable at all is therefore still correct in both places.
 *
 * Note this is evaluated at module load rather than inlined at build time, so the same
 * bundle behaves correctly whether it is opened from localhost or from the deployed site.
 */
function resolveSignalingUrl(): string {
  const configured = import.meta.env.VITE_SIGNALING_URL;
  if (configured) {
    return configured;
  }

  if (typeof window === "undefined") {
    return LOCAL_SIGNALING_URL;
  }

  const host = window.location.hostname;
  const isDevelopmentHost =
    host === "localhost" ||
    host === "127.0.0.1" ||
    host === "[::1]" ||
    host === "::1" ||
    host.endsWith(".local");

  return isDevelopmentHost ? LOCAL_SIGNALING_URL : DEPLOYED_SIGNALING_URL;
}

export const signalingUrl: string = resolveSignalingUrl();

/**
 * Per-tab identity.
 *
 * FA-1 kept the username in localStorage, which is shared across every tab of an origin.
 * Two tabs therefore could not have different names, and because the editor effect
 * depended on the username, setting a name in one tab tore down the other tab's provider
 * and reconnected it. That was cosmetic when names were decoration; it is load-bearing now
 * that election and mutual exclusion identify nodes to the user by name.
 *
 * sessionStorage is per-tab, so each tab keeps its own identity. localStorage still holds
 * the last name entered, so it can be offered as the default next time.
 */
export function readUserName(): string {
  try {
    return (
      sessionStorage.getItem("markdown-username") ??
      localStorage.getItem("markdown-username") ??
      "Anonymous"
    );
  } catch {
    return "Anonymous";
  }
}

/**
 * Optional room key, read from the URL fragment: /room/<id>#key=<secret>
 *
 * Unit I: Security, a named Design Issue that FA-1 left entirely open -- the room URL was
 * the only credential and the document travelled in the clear between peers.
 *
 * Passing a password to y-webrtc derives an encryption key from it, so peers that do not
 * know the secret cannot read the room's updates even if they reach the signaling relay
 * and learn the topic. The key lives in the URL *fragment* rather than the query string
 * because fragments are never sent to the server: the relay routes the room without ever
 * being able to decrypt it.
 *
 * What this does not provide: authentication of who is joining, authorisation of what they
 * may do, or any protection once the secret is shared. It is confidentiality against an
 * outsider, not access control among insiders.
 */
export function readRoomKey(roomId: string): string | null {
  const storageKey = `markdown-roomkey-${roomId}`;

  const match = /(?:^|[#&])key=([^&]+)/.exec(window.location.hash);
  if (match) {
    const key = decodeURIComponent(match[1]);
    try {
      sessionStorage.setItem(storageKey, key);
    } catch {
      // Storage unavailable; the key still works for this page load.
    }
    return key;
  }

  try {
    return sessionStorage.getItem(storageKey);
  } catch {
    return null;
  }
}

export function writeUserName(name: string): void {
  try {
    sessionStorage.setItem("markdown-username", name);
    localStorage.setItem("markdown-username", name);
  } catch {
    // Private browsing with storage disabled: the name just will not persist.
  }
}
