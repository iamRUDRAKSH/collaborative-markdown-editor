import { useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import "./App.css";

const initialMarkdown = `# Collaborative Markdown Editor

Start writing your Markdown here.

## Features

- Real-time editing
- Live Markdown preview
- Multiple collaborators
- Conflict resolution

You can write **bold text**, *italic text*, and ~~strikethrough text~~.
`;

function App() {
  const [markdown, setMarkdown] = useState(initialMarkdown);

  return (
    <div className="app">
      <header className="header">
        <div>
          <h1>Collaborative Markdown Editor</h1>
        </div>

        <span className="status">Single-user mode</span>
      </header>

      <main className="workspace">
        <section className="panel">
          <div className="panel-header">
            <h2>Markdown</h2>
          </div>

          <textarea
            className="editor"
            value={markdown}
            onChange={(event) => setMarkdown(event.target.value)}
            placeholder="Write Markdown here..."
            spellCheck="true"
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

export default App;