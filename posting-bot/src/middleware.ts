import { NextResponse, type NextRequest } from "next/server";

/**
 * Optionele basis-beveiliging: zet APP_PASSWORD om de hele app achter
 * HTTP Basic Auth te zetten (gebruikersnaam mag alles zijn).
 * Ondertekende media-URL's (voor Instagram) blijven bereikbaar.
 */
export function middleware(req: NextRequest) {
  const password = process.env.APP_PASSWORD;
  if (!password) return NextResponse.next();
  const { pathname, searchParams } = req.nextUrl;
  if (pathname.startsWith("/api/media/") && searchParams.has("sig")) return NextResponse.next();

  const auth = req.headers.get("authorization");
  if (auth?.startsWith("Basic ")) {
    const decoded = atob(auth.slice(6));
    if (decoded.slice(decoded.indexOf(":") + 1) === password) return NextResponse.next();
  }
  return new NextResponse("Inloggen vereist", { status: 401, headers: { "WWW-Authenticate": 'Basic realm="ClipNova Posting Bot"' } });
}

export const config = { matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"] };
