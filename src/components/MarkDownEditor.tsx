import { useEffect, useRef } from "react";
import { EditorState } from "@codemirror/state";
import { EditorView, basicSetup } from "codemirror";
import { markdown } from "@codemirror/lang-markdown";

type MarkdownEditorProps = {
    value: string;
    onChange: (value: string) => void;
};

function MarkdownEditor({ value, onChange }: MarkdownEditorProps) {
    const editorContainerRef = useRef<HTMLDivElement | null>(null);
    const editorViewRef = useRef<EditorView | null>(null);
    const onChangeRef = useRef(onChange);
    const initialValueRef = useRef(value);

    useEffect(() => {
        onChangeRef.current = onChange;
    }, [onChange]);

    useEffect(() => {
        if (!editorContainerRef.current) {
            return;
        }

        const state = EditorState.create({
            doc: initialValueRef.current,
            extensions: [
                basicSetup,
                markdown(),
                EditorView.lineWrapping,

                EditorView.updateListener.of((update) => {
                    if (update.docChanged) {
                        const updatedMarkdown = update.state.doc.toString();
                        onChangeRef.current(updatedMarkdown);
                    }
                }),
            ],
        });

        const view = new EditorView({
            state,
            parent: editorContainerRef.current,
        });

        editorViewRef.current = view;

        return () => {
            view.destroy();
            editorViewRef.current = null;
        };
    }, []);

    useEffect(() => {
        const view = editorViewRef.current;

        if (!view) {
            return;
        }

        const currentEditorValue = view.state.doc.toString();

        if (currentEditorValue === value) {
            return;
        }

        view.dispatch({
            changes: {
                from: 0,
                to: currentEditorValue.length,
                insert: value,
            },
        });
    }, [value]);

    return <div className="editor-container" ref={editorContainerRef} />;
}

export default MarkdownEditor;