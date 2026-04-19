const port = parseInt(process.env.PROXY_PORT || "3100", 10);

const server = Bun.serve({
  port,
  idleTimeout: 0,
  fetch(req: Request) {
    const url = new URL(req.url);

    if (url.pathname === "/health" && req.method === "GET") {
      return new Response(JSON.stringify({ status: "ok" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }

    return new Response("Not Found", { status: 404 });
  },
});

console.log(`Server running at http://localhost:${port}`);
