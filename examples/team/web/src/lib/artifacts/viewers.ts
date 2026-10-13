// The one map from an artifact kind to its viewer (plan P45). Adding a kind means one line here.
import type { Component } from 'svelte';
import CodeViewer from '#lib/components/artifacts/viewers/CodeViewer.svelte';
import DataViewer from '#lib/components/artifacts/viewers/DataViewer.svelte';
import DocumentViewer from '#lib/components/artifacts/viewers/DocumentViewer.svelte';
import FileViewer from '#lib/components/artifacts/viewers/FileViewer.svelte';
import HtmlViewer from '#lib/components/artifacts/viewers/HtmlViewer.svelte';
import ImageViewer from '#lib/components/artifacts/viewers/ImageViewer.svelte';
import MermaidViewer from '#lib/components/artifacts/viewers/MermaidViewer.svelte';
import type { ViewerInput } from './input.js';
import type { ArtifactKindId } from './kinds.js';

export type ViewerProps = { input: ViewerInput; onFix?: (error: string) => void };

export const VIEWERS: Record<ArtifactKindId, Component<ViewerProps>> = {
	html: HtmlViewer,
	document: DocumentViewer as Component<ViewerProps>,
	image: ImageViewer as Component<ViewerProps>,
	mermaid: MermaidViewer as Component<ViewerProps>,
	code: CodeViewer as Component<ViewerProps>,
	data: DataViewer as Component<ViewerProps>,
	file: FileViewer as Component<ViewerProps>
};

export const viewerFor = (kind: string): Component<ViewerProps> => (VIEWERS as Record<string, Component<ViewerProps>>)[kind] ?? FileViewer;
