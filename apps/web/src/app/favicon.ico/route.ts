export const runtime = "nodejs";

export function GET() {
  return new Response(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="6" fill="#1d1d1b"/><path d="M9 8h14v4H14v4h8v4h-8v4H9V8z" fill="#f7f4ea"/></svg>',
    {
      headers: {
        "Content-Type": "image/svg+xml",
        "Cache-Control": "public, max-age=86400"
      }
    }
  );
}
