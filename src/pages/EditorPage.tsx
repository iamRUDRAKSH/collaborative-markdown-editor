import { useState } from "react";
import { Link, useParams } from "react-router-dom";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import MarkdownEditor from "../components/MarkDownEditor";

function EditorPage() {
  const { roomId } = useParams();
  const [markdown, setMarkdown] = useState("");
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
          <span className="status">P2P room active</span>

          <button
            className="header-button"
            onClick={copyRoomLink}
          >
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
            roomId={roomId ?? "unknown-room"}
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