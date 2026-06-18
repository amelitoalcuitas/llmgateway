import { createOpenAI } from "@ai-sdk/openai";
import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import { RecursiveCharacterTextSplitter } from "@langchain/textsplitters";
import { embedMany } from "ai";
import { HTTPException } from "hono/http-exception";
import { extractText } from "unpdf";

import { redisClient } from "@/auth/config.js";
import { hasActiveApiKey } from "@/lib/hasActiveApiKey.js";

import { db, tables, eq, and, sql, count, inArray } from "@llmgateway/db";

import type { ServerTypes } from "@/vars.js";

async function getOpenAIClientForUser(userId: string) {
	const [keyRow] = await db
		.select({ token: tables.providerKey.token })
		.from(tables.providerKey)
		.innerJoin(
			tables.userOrganization,
			eq(
				tables.providerKey.organizationId,
				tables.userOrganization.organizationId,
			),
		)
		.where(
			and(
				eq(tables.userOrganization.userId, userId),
				eq(tables.providerKey.provider, "openai"),
				eq(tables.providerKey.status, "active"),
			),
		)
		.limit(1);

	if (!keyRow) {
		throw new HTTPException(400, {
			message:
				"No active OpenAI provider key found. Add one in Settings → Provider Keys.",
		});
	}

	return createOpenAI({ apiKey: keyRow.token });
}

const FREE_MAX_DOCS = 3;
const PAID_MAX_DOCS = 50;
const FREE_MAX_CHUNKS = 300;
const PAID_MAX_CHUNKS = 25000;
const FREE_MAX_FILE_BYTES = 5 * 1024 * 1024;
const PAID_MAX_FILE_BYTES = 10 * 1024 * 1024;
const FREE_MAX_PAGES = 50;
const PAID_MAX_PAGES = 100;
const FREE_MAX_UPLOADS_PER_DAY = 3;
const PAID_MAX_UPLOADS_PER_DAY = 50;
const SEARCH_RATE_LIMIT_PER_MINUTE = 60;
const MAX_CHUNKS_PER_QUERY = 5;
const CHUNK_SIZE = 512;
const CHUNK_OVERLAP = 50;

export const knowledge = new OpenAPIHono<ServerTypes>();

const documentSchema = z.object({
	id: z.string(),
	filename: z.string(),
	mimeType: z.string(),
	status: z.enum(["processing", "ready", "error"]),
	chunkCount: z.number(),
	pageCount: z.number(),
	fileSizeBytes: z.number(),
	errorMessage: z.string().nullable(),
	createdAt: z.string().datetime(),
	updatedAt: z.string().datetime(),
});

// GET /knowledge/documents
const listDocuments = createRoute({
	method: "get",
	path: "/documents",
	responses: {
		200: {
			content: {
				"application/json": {
					schema: z.object({
						documents: z.array(documentSchema),
					}),
				},
			},
			description: "List of knowledge base documents",
		},
	},
});

knowledge.openapi(listDocuments, async (c) => {
	const user = c.get("user");
	if (!user) {
		throw new HTTPException(401, { message: "Unauthorized" });
	}

	const docs = await db
		.select({
			id: tables.knowledgeDocument.id,
			filename: tables.knowledgeDocument.filename,
			mimeType: tables.knowledgeDocument.mimeType,
			status: tables.knowledgeDocument.status,
			chunkCount: tables.knowledgeDocument.chunkCount,
			pageCount: tables.knowledgeDocument.pageCount,
			fileSizeBytes: tables.knowledgeDocument.fileSizeBytes,
			errorMessage: tables.knowledgeDocument.errorMessage,
			createdAt: tables.knowledgeDocument.createdAt,
			updatedAt: tables.knowledgeDocument.updatedAt,
		})
		.from(tables.knowledgeDocument)
		.where(eq(tables.knowledgeDocument.userId, user.id))
		.orderBy(sql`${tables.knowledgeDocument.updatedAt} desc`);

	return c.json(
		{
			documents: docs.map((d) => ({
				...d,
				createdAt: d.createdAt.toISOString(),
				updatedAt: d.updatedAt.toISOString(),
			})),
		},
		200,
	);
});

// GET /knowledge/documents/:id/status
const getDocumentStatus = createRoute({
	method: "get",
	path: "/documents/{id}/status",
	request: {
		params: z.object({ id: z.string() }),
	},
	responses: {
		200: {
			content: {
				"application/json": {
					schema: z.object({
						status: z.enum(["processing", "ready", "error"]),
						chunkCount: z.number(),
						pageCount: z.number(),
						errorMessage: z.string().nullable(),
					}),
				},
			},
			description: "Document status",
		},
	},
});

knowledge.openapi(getDocumentStatus, async (c) => {
	const user = c.get("user");
	if (!user) {
		throw new HTTPException(401, { message: "Unauthorized" });
	}

	const { id } = c.req.valid("param");
	const [doc] = await db
		.select({
			status: tables.knowledgeDocument.status,
			chunkCount: tables.knowledgeDocument.chunkCount,
			pageCount: tables.knowledgeDocument.pageCount,
			errorMessage: tables.knowledgeDocument.errorMessage,
		})
		.from(tables.knowledgeDocument)
		.where(
			and(
				eq(tables.knowledgeDocument.id, id),
				eq(tables.knowledgeDocument.userId, user.id),
			),
		)
		.limit(1);

	if (!doc) {
		throw new HTTPException(404, { message: "Document not found" });
	}

	return c.json(doc, 200);
});

// DELETE /knowledge/documents/:id
const deleteDocument = createRoute({
	method: "delete",
	path: "/documents/{id}",
	request: {
		params: z.object({ id: z.string() }),
	},
	responses: {
		200: {
			content: {
				"application/json": {
					schema: z.object({ message: z.string() }),
				},
			},
			description: "Document deleted",
		},
	},
});

knowledge.openapi(deleteDocument, async (c) => {
	const user = c.get("user");
	if (!user) {
		throw new HTTPException(401, { message: "Unauthorized" });
	}

	const { id } = c.req.valid("param");
	const [doc] = await db
		.select({ id: tables.knowledgeDocument.id })
		.from(tables.knowledgeDocument)
		.where(
			and(
				eq(tables.knowledgeDocument.id, id),
				eq(tables.knowledgeDocument.userId, user.id),
			),
		)
		.limit(1);

	if (!doc) {
		throw new HTTPException(404, { message: "Document not found" });
	}

	await db
		.delete(tables.knowledgeDocument)
		.where(eq(tables.knowledgeDocument.id, id));

	return c.json({ message: "Document deleted" }, 200);
});

// POST /knowledge/documents (multipart — handled outside createRoute)
knowledge.post("/documents", async (c) => {
	const user = c.get("user");
	if (!user) {
		throw new HTTPException(401, { message: "Unauthorized" });
	}

	const isPaid = await hasActiveApiKey(user.id);
	const maxDocs = isPaid ? PAID_MAX_DOCS : FREE_MAX_DOCS;
	const maxChunks = isPaid ? PAID_MAX_CHUNKS : FREE_MAX_CHUNKS;
	const maxFileBytes = isPaid ? PAID_MAX_FILE_BYTES : FREE_MAX_FILE_BYTES;
	const maxPages = isPaid ? PAID_MAX_PAGES : FREE_MAX_PAGES;
	const maxUploadsPerDay = isPaid
		? PAID_MAX_UPLOADS_PER_DAY
		: FREE_MAX_UPLOADS_PER_DAY;

	let formData: FormData;
	try {
		formData = await c.req.raw.formData();
	} catch {
		throw new HTTPException(400, { message: "Invalid multipart form data" });
	}

	const file = formData.get("file");
	if (!(file instanceof File)) {
		throw new HTTPException(400, { message: "Missing file field" });
	}
	if (file.type !== "application/pdf") {
		throw new HTTPException(400, { message: "Only PDF files are supported" });
	}
	if (file.size > maxFileBytes) {
		throw new HTTPException(400, { message: "FILE_TOO_LARGE" });
	}

	// Count existing non-error docs
	const [existingDocCount] = await db
		.select({ value: count() })
		.from(tables.knowledgeDocument)
		.where(
			and(
				eq(tables.knowledgeDocument.userId, user.id),
				inArray(tables.knowledgeDocument.status, ["processing", "ready"]),
			),
		);

	if ((existingDocCount?.value ?? 0) >= maxDocs) {
		throw new HTTPException(400, { message: "DOCUMENT_LIMIT_REACHED" });
	}

	// Check daily upload rate
	const [uploadCount] = await db
		.select({ value: count() })
		.from(tables.knowledgeDocument)
		.where(
			and(
				eq(tables.knowledgeDocument.userId, user.id),
				sql`${tables.knowledgeDocument.createdAt} > NOW() - INTERVAL '24 hours'`,
			),
		);

	if ((uploadCount?.value ?? 0) >= maxUploadsPerDay) {
		throw new HTTPException(400, { message: "UPLOAD_RATE_LIMIT" });
	}

	// Count total existing chunks across all user's docs
	const [existingChunkCountRow] = await db
		.select({ value: count() })
		.from(tables.knowledgeChunk)
		.innerJoin(
			tables.knowledgeDocument,
			eq(tables.knowledgeChunk.documentId, tables.knowledgeDocument.id),
		)
		.where(
			and(
				eq(tables.knowledgeDocument.userId, user.id),
				inArray(tables.knowledgeDocument.status, ["processing", "ready"]),
			),
		);

	const existingChunkCount = existingChunkCountRow?.value ?? 0;

	// Insert doc row in processing state
	const [docRow] = await db
		.insert(tables.knowledgeDocument)
		.values({
			userId: user.id,
			filename: file.name,
			mimeType: file.type,
			fileSizeBytes: file.size,
			status: "processing",
		})
		.returning();

	if (!docRow) {
		throw new HTTPException(500, {
			message: "Failed to create document record",
		});
	}

	const setError = async (message: string) => {
		await db
			.update(tables.knowledgeDocument)
			.set({ status: "error", errorMessage: message })
			.where(eq(tables.knowledgeDocument.id, docRow.id));
	};

	let pdfBuffer: ArrayBuffer;
	try {
		pdfBuffer = await file.arrayBuffer();
	} catch {
		await setError("Failed to read file");
		throw new HTTPException(400, { message: "Failed to read file" });
	}

	let extractedText: string;
	let pageCount: number;
	try {
		const result = await extractText(new Uint8Array(pdfBuffer), {
			mergePages: true,
		});
		extractedText = Array.isArray(result.text)
			? result.text.join("\n")
			: (result.text ?? "");
		pageCount = result.totalPages ?? 0;
	} catch {
		await setError("Failed to extract text from PDF");
		throw new HTTPException(400, {
			message: "Failed to extract text from PDF",
		});
	}

	if (pageCount > maxPages) {
		await db
			.delete(tables.knowledgeDocument)
			.where(eq(tables.knowledgeDocument.id, docRow.id));
		throw new HTTPException(400, { message: "PAGE_LIMIT_REACHED" });
	}

	const splitter = new RecursiveCharacterTextSplitter({
		chunkSize: CHUNK_SIZE,
		chunkOverlap: CHUNK_OVERLAP,
	});

	let chunks: string[];
	try {
		chunks = await splitter.splitText(extractedText);
	} catch {
		await setError("Failed to split text into chunks");
		throw new HTTPException(500, { message: "Failed to split text" });
	}

	if (existingChunkCount + chunks.length > maxChunks) {
		await db
			.delete(tables.knowledgeDocument)
			.where(eq(tables.knowledgeDocument.id, docRow.id));
		throw new HTTPException(400, { message: "CHUNK_LIMIT_REACHED" });
	}

	let openaiClient;
	try {
		openaiClient = await getOpenAIClientForUser(user.id);
	} catch (err) {
		await setError("No OpenAI provider key configured");
		throw err;
	}

	let embeddings: number[][];
	try {
		const result = await embedMany({
			model: openaiClient.embedding("text-embedding-3-small"),
			values: chunks,
		});
		embeddings = result.embeddings;
	} catch {
		await setError("Failed to generate embeddings");
		throw new HTTPException(502, { message: "Failed to generate embeddings" });
	}

	try {
		await db.insert(tables.knowledgeChunk).values(
			chunks.map((content, i) => ({
				documentId: docRow.id,
				content,
				chunkIndex: i,
				embedding: embeddings[i] as number[],
			})),
		);
	} catch {
		await setError("Failed to store chunks");
		throw new HTTPException(500, { message: "Failed to store chunks" });
	}

	await db
		.update(tables.knowledgeDocument)
		.set({
			status: "ready",
			chunkCount: chunks.length,
			pageCount,
			fileSizeBytes: file.size,
		})
		.where(eq(tables.knowledgeDocument.id, docRow.id));

	return c.json(
		{
			document: {
				id: docRow.id,
				filename: docRow.filename,
				status: "ready",
				chunkCount: chunks.length,
				pageCount,
			},
		},
		201,
	);
});

// POST /knowledge/search
const searchSchema = z.object({
	query: z.string().min(1).max(2000),
	documentIds: z.array(z.string()).optional(),
	limit: z
		.number()
		.int()
		.min(1)
		.max(MAX_CHUNKS_PER_QUERY)
		.optional()
		.default(MAX_CHUNKS_PER_QUERY),
});

const search = createRoute({
	method: "post",
	path: "/search",
	request: {
		body: {
			content: {
				"application/json": {
					schema: searchSchema,
				},
			},
		},
	},
	responses: {
		200: {
			content: {
				"application/json": {
					schema: z.object({
						chunks: z.array(
							z.object({
								content: z.string(),
								documentId: z.string(),
								similarity: z.number(),
							}),
						),
					}),
				},
			},
			description: "Relevant chunks from knowledge base",
		},
	},
});

knowledge.openapi(search, async (c) => {
	const user = c.get("user");
	if (!user) {
		throw new HTTPException(401, { message: "Unauthorized" });
	}

	// Redis rate limit: 60 calls/minute per user
	try {
		const key = `knowledge_search_rate_limit:${user.id}`;
		const cnt = await redisClient.incr(key);
		if (cnt === 1) {
			await redisClient.expire(key, 60);
		}
		if (cnt > SEARCH_RATE_LIMIT_PER_MINUTE) {
			throw new HTTPException(429, { message: "SEARCH_RATE_LIMIT" });
		}
	} catch (err) {
		if (err instanceof HTTPException) {
			throw err;
		}
		// Fail open if Redis is down
	}

	const body = c.req.valid("json");
	const limit = body.limit ?? MAX_CHUNKS_PER_QUERY;

	// Early return if no ready documents
	const [readyDocCount] = await db
		.select({ value: count() })
		.from(tables.knowledgeDocument)
		.where(
			and(
				eq(tables.knowledgeDocument.userId, user.id),
				eq(tables.knowledgeDocument.status, "ready"),
			),
		);

	if ((readyDocCount?.value ?? 0) === 0) {
		return c.json({ chunks: [] }, 200);
	}

	const openaiClient = await getOpenAIClientForUser(user.id);

	const {
		embeddings: [queryVector],
	} = await embedMany({
		model: openaiClient.embedding("text-embedding-3-small"),
		values: [body.query],
	});

	const docFilter =
		body.documentIds && body.documentIds.length > 0
			? sql`AND kd.id = ANY(ARRAY[${sql.join(
					body.documentIds.map((id) => sql`${id}`),
					sql`, `,
				)}]::text[])`
			: sql``;

	const rows = await db.execute<{
		content: string;
		document_id: string;
		similarity: number;
	}>(
		sql`
			SELECT kc.content, kc.document_id,
				1 - (kc.embedding <=> ${JSON.stringify(queryVector)}::vector) AS similarity
			FROM knowledge_chunk kc
			JOIN knowledge_document kd ON kc.document_id = kd.id
			WHERE kd.user_id = ${user.id}
				AND kd.status = 'ready'
				${docFilter}
			ORDER BY kc.embedding <=> ${JSON.stringify(queryVector)}::vector
			LIMIT ${limit}
		`,
	);

	const chunks = rows.rows.map((r) => ({
		content: r.content,
		documentId: r.document_id,
		similarity: r.similarity,
	}));

	// Fire-and-forget: update lastAccessedAt on matched documents
	const matchedDocIds = [...new Set(chunks.map((c) => c.documentId))];
	if (matchedDocIds.length > 0) {
		db.update(tables.knowledgeDocument)
			.set({ lastAccessedAt: new Date() })
			.where(inArray(tables.knowledgeDocument.id, matchedDocIds))
			.catch(() => undefined);
	}

	return c.json({ chunks }, 200);
});
