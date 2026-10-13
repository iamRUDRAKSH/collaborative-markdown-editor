import { useEffect, useRef } from "react";
import * as Y from "yjs";
import { WebrtcProvider } from "y-webrtc";
import { IndexeddbPersistence } from "y-indexeddb";
import { EditorState } from "@codemirror/state";
import { EditorView, basicSetup } from "codemirror";
import { markdown } from "@codemirror/lang-markdown";
import { placeholder } from "@codemirror/view";
import { yCollab, ySyncAnnotation } from "y-codemirror.next";
import { readRoomKey, signalingUrl } from "../ds/config";

export type Collaborator = {
    clientId: number;
    name: string;
    color: string;
};

/** A character range another node holds exclusively, so this node may not edit it. */
export type LockedRange = {
    from: number;
    to: number;
    holder: number;
    title: string;
};

type MarkdownEditorProps = {
    roomId: string;
    username: string;
    onChange: (value: string) => void;
    onCollaboratorsChange: (
        collaborators: Collaborator[],
    ) => void;
    /**
     * Ranges currently locked by other nodes. A ref rather than a prop value so that lock
     * changes do not re-run the effect and rebuild the Yjs provider.
     */
    lockedRangesRef?: { current: LockedRange[] };
    /** Called when an edit is rejected because the section is locked elsewhere. */
    onBlocked?: (range: LockedRange) => void;
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
    lockedRangesRef,
    onBlocked,
}: MarkdownEditorProps) {
    const editorContainerRef =
        useRef<HTMLDivElement | null>(null);

    const onChangeRef = useRef(onChange);
    const onCollaboratorsChangeRef =
        useRef(onCollaboratorsChange);
    const onBlockedRef = useRef(onBlocked);

    useEffect(() => {
        onBlockedRef.current = onBlocked;
    }, [onBlocked]);

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

        // When a room key is present the Yjs room is encrypted: peers without the secret
        // can reach the signaling topic but cannot read any document update.
        const roomKey = readRoomKey(roomId);

        const provider = new WebrtcProvider(roomId, ydoc, {
            signaling: [signalingUrl],
            ...(roomKey ? { password: roomKey } : {}),
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

        /**
         * Enforcement point for distributed mutual exclusion.
         *
         * The CRDT would happily merge an edit into a section another node has locked --
         * that is precisely what it is designed to do. The lock only means anything if
         * something refuses the edit, so this filter drops any transaction whose changes
         * touch a range held elsewhere.
         *
         * It guards the local editor only. A node that bypassed this check could still
         * write to the section, because nothing in a peer-to-peer CRDT can stop it. The
         * honest claim is that this enforces the lock among cooperating nodes, not against
         * an adversarial one.
         */
        const lockFilter = EditorState.transactionFilter.of((tr) => {
            if (!tr.docChanged || !lockedRangesRef) {
                return tr;
            }

            // Remote CRDT updates carry y-codemirror's sync annotation. They must always
            // be applied: rejecting one would make this replica diverge permanently, which
            // is a far worse outcome than letting a locked section receive a remote edit.
            // The lock is enforced where the edit originates, not where it lands.
            if (tr.annotation(ySyncAnnotation) !== undefined) {
                return tr;
            }

            const ranges = lockedRangesRef.current;
            if (ranges.length === 0) {
                return tr;
            }

            let blocked: LockedRange | null = null;

            tr.changes.iterChangedRanges((fromA, toA) => {
                if (blocked) {
                    return;
                }
                for (const range of ranges) {
                    // Overlap test against the locked span, in pre-change coordinates.
                    if (fromA < range.to && toA > range.from) {
                        blocked = range;
                        return;
                    }
                }
            });

            if (blocked) {
                onBlockedRef.current?.(blocked);
                return [];
            }

            return tr;
        });

        const state = EditorState.create({
            doc: ytext.toString(),
            extensions: [
                basicSetup,
                markdown(),
                EditorView.lineWrapping,
                placeholder("Start writing Markdown here..."),
                lockFilter,
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
        // lockedRangesRef is a stable ref object, so listing it never re-runs the effect
        // and never rebuilds the Yjs provider; it is here only to satisfy the lint rule.
    }, [roomId, username, lockedRangesRef]);

    return (
        <div
            className="editor-container"
            ref={editorContainerRef}
        />
    );
}

export default MarkdownEditor;