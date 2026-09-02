import { useEffect, useRef } from "react";
import * as Y from "yjs";
import { WebrtcProvider } from "y-webrtc";
import { IndexeddbPersistence } from "y-indexeddb";
import { EditorState } from "@codemirror/state";
import { EditorView, basicSetup } from "codemirror";
import { markdown } from "@codemirror/lang-markdown";
import { placeholder } from "@codemirror/view";
import { yCollab } from "y-codemirror.next";

type MarkdownEditorProps = {
  roomId: string;
  onChange: (value: string) => void;
};

const userColors = [
  "#2563eb",
  "#dc2626",
  "#16a34a",
  "#9333ea",
  "#ea580c",
  "#0891b2",
];

function MarkdownEditor({
  roomId,
  onChange,
}: MarkdownEditorProps) {
  const editorContainerRef = useRef<HTMLDivElement | null>(null);
  const onChangeRef = useRef(onChange);

  useEffect(() => {
    onChangeRef.current = onChange;
  }, [onChange]);

  useEffect(() => {
    if (!editorContainerRef.current) {
      return;
    }

    // Every browser creates its own local CRDT document.
    const ydoc = new Y.Doc();

    // Peers using the same room ID access the same shared text.
    const ytext = ydoc.getText("markdown");

    // Store this room's document locally in IndexedDB.
    const persistence = new IndexeddbPersistence(
      `markdown-room-${roomId}`,
      ydoc,
    );

    // Exchange Yjs document updates through WebRTC.
    const provider = new WebrtcProvider(roomId, ydoc, {
      signaling: ["ws://localhost:4444"],
    });

    const color =
      userColors[ydoc.clientID % userColors.length];

    // Temporary information used for remote cursors.
    provider.awareness.setLocalStateField("user", {
      name: `User-${String(ydoc.clientID).slice(-4)}`,
      color,
      colorLight: `${color}33`,
    });

    // Give each peer its own undo and redo history.
    const undoManager = new Y.UndoManager(ytext);

    const state = EditorState.create({
      doc: ytext.toString(),
      extensions: [
        basicSetup,
        markdown(),
        EditorView.lineWrapping,
        placeholder("Start writing Markdown here..."),
        yCollab(ytext, provider.awareness, {
          undoManager,
        }),
      ],
    });

    const view = new EditorView({
      state,
      parent: editorContainerRef.current,
    });

    function updatePreview() {
      onChangeRef.current(ytext.toString());
    }

    ytext.observe(updatePreview);
    updatePreview();

    persistence.once("synced", () => {
      console.log("Local document loaded for room:", roomId);
    });

    return () => {
      ytext.unobserve(updatePreview);
      view.destroy();
      provider.destroy();
      persistence.destroy();
      ydoc.destroy();
    };
  }, [roomId]);

  return (
    <div
      className="editor-container"
      ref={editorContainerRef}
    />
  );
}

export default MarkdownEditor;