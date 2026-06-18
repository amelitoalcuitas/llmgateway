"use client";

import { BookOpen, Loader2, Trash2, UploadCloud } from "lucide-react";
import { useEffect, useRef } from "react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogHeader,
	DialogTitle,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Progress } from "@/components/ui/progress";
import { Switch } from "@/components/ui/switch";
import {
	useDeleteKnowledgeDocument,
	useKnowledgeDocuments,
	useUploadKnowledgeDocument,
} from "@/hooks/useKnowledgeDocuments";

const FREE_MAX_DOCS = 3;

interface KnowledgeBaseDialogProps {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	isPaid: boolean;
	enabled: boolean;
	onEnabledChange: (enabled: boolean) => void;
}

function formatBytes(bytes: number) {
	if (bytes < 1024) {
		return `${bytes} B`;
	}
	if (bytes < 1024 * 1024) {
		return `${(bytes / 1024).toFixed(1)} KB`;
	}
	return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function KnowledgeBaseDialog({
	open,
	onOpenChange,
	isPaid,
	enabled,
	onEnabledChange,
}: KnowledgeBaseDialogProps) {
	const { data, refetch } = useKnowledgeDocuments();
	const uploadMutation = useUploadKnowledgeDocument();
	const deleteMutation = useDeleteKnowledgeDocument();
	const fileInputRef = useRef<HTMLInputElement>(null);
	const pollingRef = useRef<ReturnType<typeof setInterval> | null>(null);

	const documents = data?.documents ?? [];
	const activeDocCount = documents.filter(
		(d) => d.status === "processing" || d.status === "ready",
	).length;
	const hasProcessing = documents.some((d) => d.status === "processing");

	useEffect(() => {
		if (hasProcessing) {
			pollingRef.current = setInterval(() => {
				void refetch();
			}, 3000);
		} else {
			if (pollingRef.current) {
				clearInterval(pollingRef.current);
				pollingRef.current = null;
			}
		}
		return () => {
			if (pollingRef.current) {
				clearInterval(pollingRef.current);
				pollingRef.current = null;
			}
		};
	}, [hasProcessing, refetch]);

	const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
		const file = e.target.files?.[0];
		if (!file) {
			return;
		}
		uploadMutation.mutate(file);
		e.target.value = "";
	};

	const handleDelete = (id: string) => {
		deleteMutation.mutate({ params: { path: { id } } });
	};

	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent className="max-w-lg">
				<DialogHeader>
					<DialogTitle className="flex items-center gap-2">
						<BookOpen className="h-5 w-5" />
						Knowledge Base
					</DialogTitle>
					<DialogDescription>
						Upload PDFs to give the chat context from your documents.
					</DialogDescription>
				</DialogHeader>

				<div className="flex items-center justify-between rounded-md border p-3">
					<div>
						<Label htmlFor="kb-enabled" className="text-sm font-medium">
							Use knowledge base in this chat
						</Label>
						<p className="text-xs text-muted-foreground">
							Relevant excerpts will be injected as context
						</p>
					</div>
					<Switch
						id="kb-enabled"
						checked={enabled}
						onCheckedChange={onEnabledChange}
						disabled={
							documents.filter((d) => d.status === "ready").length === 0
						}
					/>
				</div>

				<div className="space-y-4">
					{!isPaid && (
						<div className="space-y-1">
							<div className="flex justify-between text-sm text-muted-foreground">
								<span>Documents used</span>
								<span>
									{activeDocCount} / {FREE_MAX_DOCS}
								</span>
							</div>
							<Progress value={(activeDocCount / FREE_MAX_DOCS) * 100} />
						</div>
					)}

					<div>
						<input
							ref={fileInputRef}
							type="file"
							accept=".pdf"
							className="hidden"
							onChange={handleFileChange}
						/>
						<Button
							variant="outline"
							className="w-full"
							onClick={() => fileInputRef.current?.click()}
							disabled={uploadMutation.isPending}
						>
							{uploadMutation.isPending ? (
								<>
									<Loader2 className="mr-2 h-4 w-4 animate-spin" />
									Uploading…
								</>
							) : (
								<>
									<UploadCloud className="mr-2 h-4 w-4" />
									Upload PDF
								</>
							)}
						</Button>
					</div>

					{documents.length === 0 ? (
						<p className="text-center text-sm text-muted-foreground py-4">
							No documents yet. Upload a PDF to get started.
						</p>
					) : (
						<ul className="space-y-2 max-h-72 overflow-y-auto">
							{documents.map((doc) => (
								<li
									key={doc.id}
									className="flex items-start justify-between gap-2 rounded-md border p-3"
								>
									<div className="min-w-0 flex-1">
										<p className="truncate text-sm font-medium">
											{doc.filename}
										</p>
										<div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
											{doc.status === "ready" && (
												<>
													<span>{doc.pageCount} pages</span>
													<span>·</span>
													<span>{doc.chunkCount} chunks</span>
													<span>·</span>
													<span>{formatBytes(doc.fileSizeBytes)}</span>
												</>
											)}
											{doc.status === "processing" && (
												<span className="flex items-center gap-1">
													<Loader2 className="h-3 w-3 animate-spin" />
													Processing…
												</span>
											)}
											{doc.status === "error" && doc.errorMessage && (
												<span className="text-destructive">
													{doc.errorMessage}
												</span>
											)}
										</div>
									</div>
									<div className="flex shrink-0 items-center gap-2">
										<StatusBadge status={doc.status} />
										<Button
											variant="ghost"
											size="icon"
											className="h-7 w-7"
											onClick={() => handleDelete(doc.id)}
											disabled={deleteMutation.isPending}
										>
											<Trash2 className="h-4 w-4" />
										</Button>
									</div>
								</li>
							))}
						</ul>
					)}
				</div>
			</DialogContent>
		</Dialog>
	);
}

function StatusBadge({ status }: { status: "processing" | "ready" | "error" }) {
	if (status === "ready") {
		return <Badge variant="secondary">Ready</Badge>;
	}
	if (status === "processing") {
		return <Badge variant="outline">Processing</Badge>;
	}
	return <Badge variant="destructive">Error</Badge>;
}
