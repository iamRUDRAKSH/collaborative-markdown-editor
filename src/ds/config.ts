/**
 * Deployment configuration shared by the Yjs replica and the coordination mesh.
 *
 * Both meshes use the same signaling relay but subscribe to different topics, so one
 * server serves document synchronisation and coordination discovery without either
 * knowing about the other.
 */

export const signalingUrl: string =
  import.meta.env.VITE_SIGNALING_URL ?? "ws://localhost:4444";

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
