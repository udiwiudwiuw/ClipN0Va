import { NextResponse } from "next/server";
import { ZodError } from "zod";

/** Uniforme foutafhandeling voor API-routes. */
export function handler<A extends unknown[]>(fn: (...args: A) => Promise<Response>) {
  return async (...args: A): Promise<Response> => {
    try {
      return await fn(...args);
    } catch (err) {
      if (err instanceof ZodError) {
        return NextResponse.json({ error: "Ongeldige invoer", issues: err.issues }, { status: 400 });
      }
      const status = (err as { status?: number }).status ?? 500;
      console.error("[api]", err);
      return NextResponse.json({ error: (err as Error).message || "Onbekende fout" }, { status: status >= 400 && status < 600 ? status : 500 });
    }
  };
}

export class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}
