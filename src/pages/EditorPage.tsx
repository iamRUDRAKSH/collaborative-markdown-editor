import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import MarkdownEditor, {
    type Collaborator,
} from "../components/MarkDownEditor";

function EditorPage() {
    const { roomId } = useParams();
    const username = localStorage.getItem("markdown-username") ?? "Anonymous";
    const [markdown, setMarkdown] = useState("");
    const [copied, setCopied] = useState(false);
    const [collaborators, setCollaborators] = useState<
        Collaborator[]
    >([]);
    const [documentHash, setDocumentHash] = useState("");

    async function copyRoomLink() {
        await navigator.clipboard.writeText(window.location.href);

        setCopied(true);

        window.setTimeout(() => {
            setCopied(false);
        }, 2000);
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
            const encodedDocument = new TextEncoder().encode(
                markdown,
            );

            const hashBuffer = await crypto.subtle.digest(
                "SHA-256",
                encodedDocument,
            );

            const hash = Array.from(
                new Uint8Array(hashBuffer),
            )
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
                                {documentHash
                                    ? documentHash.slice(0, 12)
                                    : "calculating..."}
                            </code>
                        </span>
                    </div>
                </div>

                <div className="header-actions">
                    <div className="collaborator-list">
                        {collaborators.map((collaborator) => (
                            <span
                                className="collaborator-chip"
                                key={collaborator.clientId}
                            >
                                <span
                                    className="collaborator-dot"
                                    style={{
                                        backgroundColor: collaborator.color,
                                    }}
                                />

                                {collaborator.name}
                            </span>
                        ))}
                    </div>

                    <span className="status">
                        {collaborators.length}{" "}
                        {collaborators.length === 1 ? "user" : "users"}{" "}
                        connected
                    </span>

                    <button
                        className="header-button"
                        onClick={copyRoomLink}
                    >
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

            <main className="workspace">
                <section className="panel">
                    <div className="panel-header">
                        <h2>Markdown</h2>
                    </div>

                    <MarkdownEditor
                        roomId={roomId ?? "unknown-room"}
                        username={username}
                        onChange={setMarkdown}
                        onCollaboratorsChange={setCollaborators}
                    />
                </section>

                <section className="panel">
                    <div className="panel-header">
                        <h2>Preview</h2>
                    </div>

                    <article className="preview">
                        <ReactMarkdown remarkPlugins={[remarkGfm]}>
                            {markdown}
                        </ReactMarkdown>
                    </article>
                </section>
            </main>
        </div>
    );
}

export default EditorPage;