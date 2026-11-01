import { type DragEvent, useCallback, useRef, useState } from "react";
import { hasFiles } from "@/lib/upload";

/** Drag-over state plus the four handlers that make an element a file drop target (nested children do not flicker the state). */
export function useFileDrop(onFiles: (files: File[]) => void, disabled = false) {
	const depth = useRef(0);
	const [dragging, setDragging] = useState(false);
	const onDragEnter = useCallback(
		(e: DragEvent) => {
			if (disabled || !hasFiles(e)) return;
			e.preventDefault();
			depth.current++;
			setDragging(true);
		},
		[disabled],
	);
	const onDragOver = useCallback(
		(e: DragEvent) => {
			if (disabled || !hasFiles(e)) return;
			e.preventDefault();
			e.dataTransfer.dropEffect = "copy";
		},
		[disabled],
	);
	const onDragLeave = useCallback(
		(e: DragEvent) => {
			if (disabled || !hasFiles(e)) return;
			depth.current = Math.max(0, depth.current - 1);
			if (depth.current === 0) setDragging(false);
		},
		[disabled],
	);
	const onDrop = useCallback(
		(e: DragEvent) => {
			if (disabled || !hasFiles(e)) return;
			e.preventDefault();
			depth.current = 0;
			setDragging(false);
			onFiles(Array.from(e.dataTransfer.files));
		},
		[disabled, onFiles],
	);
	return { dragging, handlers: { onDragEnter, onDragOver, onDragLeave, onDrop } };
}
