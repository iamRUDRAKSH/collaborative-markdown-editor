/**
 * React binding for the coordination node.
 *
 * The node is created once per room and lives outside React's render cycle; this hook
 * just mirrors its state into component state so the inspector can render it.
 */

import { useEffect, useRef, useState } from "react";
import { DsNode } from "./node";
import type { DsState } from "./node";

export type UseDsNode = {
  node: DsNode | null;
  state: DsState | null;
};

export function useDsNode(options: {
  roomId: string;
  userName: string;
  signalingUrl: string;
  docLength: () => number;
}): UseDsNode {
  const [node, setNode] = useState<DsNode | null>(null);
  const [state, setState] = useState<DsState | null>(null);

  // Kept in a ref so changing the document does not tear the node down and re-elect.
  const docLengthRef = useRef(options.docLength);

  useEffect(() => {
    docLengthRef.current = options.docLength;
  }, [options.docLength]);

  const { roomId, userName, signalingUrl } = options;

  useEffect(() => {
    const created = new DsNode({
      roomId,
      userName,
      signalingUrl,
      docLength: () => docLengthRef.current(),
    });

    const unsubscribe = created.subscribe(setState);
    created.start();
    setNode(created);

    return () => {
      unsubscribe();
      created.destroy();
      setNode(null);
      setState(null);
    };
  }, [roomId, userName, signalingUrl]);

  return { node, state };
}
