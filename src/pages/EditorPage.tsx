import { useState } from "react";
import { Link, useParams } from "react-router-dom";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import MarkdownEditor from "../components/MarkdownEditor";

const initialMarkdown = `# Collaborative Markdown Editor

Start writing your Markdown here.

## Features

- Real-time editing
- Live Markdown preview
- Multiple collaborators
- Conflict resolution

You can write **bold text**, *italic text*, and ~~strikethrough text~~.
`;

function EditorPage() {
    const { roomId } = useParams();
    const [markdown, setMarkdown] = useState(initialMarkdown);
    const [copied, setCopied] = useState(false);

    async function copyRoomLink() {
        await navigator.clipboard.writeText(window.location.href);

        setCopied(true);

        window.setTimeout(() => {
            setCopied(false);
        }, 2000);
    }

    return (
        <div className="app">
            <header className="header">
                <div>
                    <h1>Collaborative Markdown Editor</h1>
                    <p>
                        Room: <strong>{roomId}</strong>
                    </p>
                </div>

                <div className="header-actions">
                    <span className="status">Single-user mode</span>

                    <button className="header-button" onClick={copyRoomLink}>
                        {copied ? "Link Copied!" : "Copy Room Link"}
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
                        value={markdown}
                        onChange={setMarkdown}
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