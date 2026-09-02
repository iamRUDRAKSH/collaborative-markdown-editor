import { useEffect, useRef } from "react";
import * as Y from "yjs";
import { WebrtcProvider } from "y-webrtc";
import { IndexeddbPersistence } from "y-indexeddb";
import { EditorState } from "@codemirror/state";
import { EditorView, basicSetup } from "codemirror";
import { markdown } from "@codemirror/lang-markdown";
import { placeholder } from "@codemirror/view";
import { yCollab } from "y-codemirror.next";

export type Collaborator = {
  clientId: number;
  name: string;
  color: string;
};

type MarkdownEditorProps = {
  roomId: string;
  username: string;
  onChange: (value: string) => void;
  onCollaboratorsChange: (
    collaborators: Collaborator[],
  ) => void;
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
  username,
  onChange,
  onCollaboratorsChange,
}: MarkdownEditorProps) {
  const editorContainerRef =
    useRef<HTMLDivElement | null>(null);

  const onChangeRef = useRef(onChange);
  const onCollaboratorsChangeRef =
    useRef(onCollaboratorsChange);

  useEffect(() => {
    onChangeRef.current = onChange;
  }, [onChange]);

  useEffect(() => {
    onCollaboratorsChangeRef.current =
      onCollaboratorsChange;
  }, [onCollaboratorsChange]);

  useEffect(() => {
    if (!editorContainerRef.current) {
      return;
    }

    const ydoc = new Y.Doc();
    const ytext = ydoc.getText("markdown");

    const persistence = new IndexeddbPersistence(
      `markdown-room-${roomId}`,
      ydoc,
    );

    const provider = new WebrtcProvider(roomId, ydoc, {
      signaling: ["ws://localhost:4444"],
    });

    const color =
      userColors[ydoc.clientID % userColors.length];

    provider.awareness.setLocalStateField("user", {
      name: username,
      color,
      colorLight: `${color}33`,
    });

    function updateCollaborators() {
      const collaborators: Collaborator[] = Array.from(
        provider.awareness.getStates().entries(),
      ).map(([clientId, state]) => ({
        clientId,
        name:
          typeof state.user?.name === "string"
            ? state.user.name
            : "Anonymous",
        color:
          typeof state.user?.color === "string"
            ? state.user.color
            : "#64748b",
      }));

      onCollaboratorsChangeRef.current(collaborators);
    }

    provider.awareness.on(
      "change",
      updateCollaborators,
    );

    updateCollaborators();

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
      console.log(
        "Local document loaded for room:",
        roomId,
      );
    });

    return () => {
      ytext.unobserve(updatePreview);

      provider.awareness.off(
        "change",
        updateCollaborators,
      );

      view.destroy();
      provider.destroy();
      persistence.destroy();
      ydoc.destroy();
    };
  }, [roomId, username]);

  return (
    <div
      className="editor-container"
      ref={editorContainerRef}
    />
  );
}

export default MarkdownEditor;