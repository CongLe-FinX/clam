import { z } from "zod";

/** ISO-8601 timestamp string. */
export const IsoDate = z.string();
export type IsoDate = z.infer<typeof IsoDate>;

export const Id = z.string().min(1);
export type Id = z.infer<typeof Id>;

/** Every non-2xx JSON response from the local API has this shape. */
export const ApiErrorBody = z.object({
	error: z.object({
		code: z.string(),
		message: z.string(),
		details: z.unknown().optional(),
	}),
});
export type ApiErrorBody = z.infer<typeof ApiErrorBody>;

/** Cursor-paginated list. */
export const page = <T extends z.ZodType>(item: T) =>
	z.object({
		items: z.array(item),
		nextCursor: z.string().nullable(),
	});

/**
 * Provenance of a number shown in the UI. Usage figures MUST carry one so the UI
 * can distinguish OMP-recorded actuals from provider-reported quota and from
 * CL Agent Mesh's own estimates.
 */
export const DataSource = z.enum(["omp-recorded", "provider-reported", "clam-estimated"]);
export type DataSource = z.infer<typeof DataSource>;
