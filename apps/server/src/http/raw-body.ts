import type { FastifyInstance } from "fastify";

/** Make `scope` pass the request stream through untouched, whatever its content type (uploads of any file type; never buffered). */
export function rawBodyScope(scope: FastifyInstance): void {
	scope.removeAllContentTypeParsers();
	scope.addContentTypeParser("*", (_request, payload, done) => done(null, payload));
}
