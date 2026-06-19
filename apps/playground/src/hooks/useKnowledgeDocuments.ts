import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

import { useAppConfig } from "@/lib/config";
import { useApi } from "@/lib/fetch-client";

export interface KnowledgeDocument {
	id: string;
	filename: string;
	mimeType: string;
	status: "processing" | "ready" | "error";
	chunkCount: number;
	pageCount: number;
	fileSizeBytes: number;
	errorMessage: string | null;
	createdAt: string;
	updatedAt: string;
}

export function useKnowledgeDocuments() {
	const api = useApi();
	return api.useQuery("get", "/knowledge/documents");
}

export function useDeleteKnowledgeDocument() {
	const api = useApi();
	const queryClient = useQueryClient();

	return api.useMutation("delete", "/knowledge/documents/{id}", {
		onSuccess: () => {
			void queryClient.invalidateQueries({
				queryKey: ["get", "/knowledge/documents"],
			});
		},
		onError: () => {
			toast.error("Failed to delete document");
		},
	});
}

export function useKnowledgeDocumentStatus(id: string | null) {
	const api = useApi();
	return api.useQuery(
		"get",
		"/knowledge/documents/{id}/status",
		{
			params: { path: { id: id ?? "" } },
		},
		{ enabled: !!id },
	);
}

export function useUploadKnowledgeDocument() {
	const config = useAppConfig();
	const queryClient = useQueryClient();

	return useMutation({
		mutationFn: async (file: File) => {
			const formData = new FormData();
			formData.append("file", file);

			const res = await fetch(`${config.apiUrl}/knowledge/documents`, {
				method: "POST",
				credentials: "include",
				body: formData,
			});

			if (!res.ok) {
				const json = await res.json().catch(() => ({}));
				throw new Error(
					(json as { message?: string })?.message ?? "Upload failed",
				);
			}

			return await res.json();
		},
		onSuccess: () => {
			void queryClient.invalidateQueries({
				queryKey: ["get", "/knowledge/documents"],
			});
		},
		onError: (err: Error) => {
			const readable: Record<string, string> = {
				FILE_TOO_LARGE: "File exceeds the size limit for your plan",
				DOCUMENT_LIMIT_REACHED: "Document limit reached for your plan",
				UPLOAD_RATE_LIMIT: "Upload rate limit reached — try again later",
				PAGE_LIMIT_REACHED: "PDF has too many pages for your plan",
				CHUNK_LIMIT_REACHED: "Knowledge base chunk limit reached for your plan",
			};
			toast.error(readable[err.message] ?? err.message ?? "Upload failed");
		},
	});
}
