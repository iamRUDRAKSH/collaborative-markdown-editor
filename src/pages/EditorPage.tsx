import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useParams } from "react-router-dom";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import MarkdownEditor, {
    type Collaborator,
    type LockedRange,
} from "../components/MarkDownEditor";
import InspectorPanel from "../components/InspectorPanel";
import { readUserName, signalingUrl } from "../ds/config";
import { useDsNode } from "../ds/useDsNode";
import { lockedRanges, parseSections } from "../ds/sections";

function EditorPage() {
    const { roomId } = useParams();

    // Read once per mount. Reading on every render used to rebuild the Yjs provider
    // whenever another tab changed the stored name.
    const [username] = useState(readUserName);

    const [markdown, setMarkdown] = useState("");
    const [copied, setCopied] = useState(false);
    const [collaborators, setCollaborators] = useState<Collaborator[]>([]);
    const [documentHash, setDocumentHash] = useState("");
    const [showInspector, setShowInspector] = useState(true);
    const [blockedNotice, setBlockedNotice] = useState<string | null>(null);

    // The coordination node needs the document length for snapshots, but must not be torn
    // down every keystroke, so the length is read through a ref.
    const markdownRef = useRef(markdown);

    useEffect(() => {
        markdownRef.current = markdown;
    }, [markdown]);

    const { node, state } = useDsNode({
        roomId: roomId ?? "unknown-room",
        userName: username,
        signalingUrl,
        docLength: () => markdownRef.current.length,
    });

    const sections = useMemo(() => parseSections(markdown), [markdown]);

    // Locked ranges are handed to the editor through a stable ref so lock changes never
    // re-run the editor effect.
    const lockedRef = useRef<LockedRange[]>([]);

    useEffect(() => {
        if (!state) {
            lockedRef.current = [];
            return;
        }
        const holders = new Map(state.locks.map((lock) => [lock.section, lock.holder]));
        lockedRef.current = lockedRanges(markdown, holders, state.selfId);
    }, [markdown, state]);

    async function copyRoomLink() {
        await navigator.clipboard.writeText(window.location.href);
        setCopied(true);
        window.setTimeout(() => setCopied(false), 2000);
    }

    function downloadMarkdown() {
        const file = new Blob([markdown], {
            type: "text/markdown;charset=utf-8",
        });

        const downloadUrl = URL.createObjectURL(file);
        const link = document.createElement("a");

        link.href = downloadUrl;
        link.download = `document-${roomId ?? "untitled"}.md`;

        document.body.appendChild(link);
        link.click();
        link.remove();

        URL.revokeObjectURL(downloadUrl);
    }

    useEffect(() => {
        let cancelled = false;

        async function calculateDocumentHash() {
            const encodedDocument = new TextEncoder().encode(markdown);
            const hashBuffer = await crypto.subtle.digest("SHA-256", encodedDocument);

            const hash = Array.from(new Uint8Array(hashBuffer))
                .map((byte) => byte.toString(16).padStart(2, "0"))
                .join("");

            if (!cancelled) {
                setDocumentHash(hash);
            }
        }

        void calculateDocumentHash();

        return () => {
            cancelled = true;
        };
    }, [markdown]);

    useEffect(() => {
        if (blockedNotice === null) {
            return;
        }
        const timer = window.setTimeout(() => setBlockedNotice(null), 2500);
        return () => window.clearTimeout(timer);
    }, [blockedNotice]);

    return (
        <div className="app">
            <header className="header">
                <div>
                    <h1>Collaborative Markdown Editor</h1>

                    <p>
                        Room: <strong>{roomId}</strong>
                    </p>
                    <div className="document-metrics">
                        <span>Characters: {markdown.length}</span>

                        <span>
                            Hash:{" "}
                            <code title={documentHash}>
                                {documentHash ? documentHash.slice(0, 12) : "calculating..."}
                            </code>
                        </span>

                        {state && (
                            <span>
                                Node: <code>{state.selfId}</code>
                            </span>
                        )}
                    </div>
                </div>

                <div className="header-actions">
                    <div className="collaborator-list">
                        {collaborators.map((collaborator) => (
                            <span className="collaborator-chip" key={collaborator.clientId}>
                                <span
                                    className="collaborator-dot"
                                    style={{ backgroundColor: collaborator.color }}
                                />
                                {collaborator.name}
                            </span>
                        ))}
                    </div>

                    <span className="status">
                        {collaborators.length}{" "}
                        {collaborators.length === 1 ? "user" : "users"} connected
                    </span>

                    <button
                        className="header-button"
                        onClick={() => setShowInspector((shown) => !shown)}
                    >
                        {showInspector ? "Hide Inspector" : "Show Inspector"}
                    </button>

                    <button className="header-button" onClick={copyRoomLink}>
                        {copied ? "Link Copied!" : "Copy Room Link"}
                    </button>

                    <button
                        className="header-button download-button"
                        onClick={downloadMarkdown}
                        disabled={!markdown}
                    >
                        Download Markdown
                    </button>

                    <Link className="leave-link" to="/">
                        Leave Room
                    </Link>
                </div>
            </header>

            {blockedNotice && <div className="blocked-banner">{blockedNotice}</div>}

            <main className={showInspector ? "workspace workspace-compact" : "workspace"}>
                <section className="panel">
                    <div className="panel-header">
                        <h2>Markdown</h2>
                    </div>

                    <MarkdownEditor
                        roomId={roomId ?? "unknown-room"}
                        username={username}
                        onChange={setMarkdown}
                        onCollaboratorsChange={setCollaborators}
                        lockedRangesRef={lockedRef}
                        onBlocked={(range) =>
                            setBlockedNotice(
                                `"${range.title}" is locked by node ${range.holder} -- edit rejected.`,
                            )
                        }
                    />
                </section>

                <section className="panel">
                    <div className="panel-header">
                        <h2>Preview</h2>
                    </div>

                    <article className="preview">
                        <ReactMarkdown remarkPlugins={[remarkGfm]}>{markdown}</ReactMarkdown>
                    </article>
                </section>
            </main>

            {showInspector && node && state && (
                <InspectorPanel node={node} state={state} sections={sections} />
            )}
        </div>
    );
}

export default EditorPage;
