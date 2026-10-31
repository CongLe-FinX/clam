import { lazy, Suspense } from "react";

export interface LightboxItem {
	src: string;
	alt: string;
	/** Present for files with a download endpoint. */
	downloadUrl?: string;
	name?: string;
}
export interface LightboxProps {
	items: LightboxItem[];
	index: number;
	onIndexChange: (index: number) => void;
	onClose: () => void;
}

const Lightbox = lazy(() => import("./lightbox.tsx"));

/** The lightbox chunk loads on first open only. Mount it while a viewer is open, unmount on close. */
export function LazyLightbox(props: LightboxProps) {
	return (
		<Suspense fallback={null}>
			<Lightbox {...props} />
		</Suspense>
	);
}
